// 权限规则（allowlist），裁剪自参考项目 src/utils/permissions/ 的核心概念。
// 参考实现有 allow/deny/ask 三态行为、路径 glob 规则、按项目/用户/托管分层的 settings，
// 以及 Bash 复合命令逐段校验。mini 只取最实用的一层：
//   - 只有 allow 规则（记住后自动放行），deny 由 BashTool 的 dangerousCommands 独立兜底
//   - 规则字符串对齐参考格式 `ToolName` 或 `ToolName(specifier)`
//       · Bash 用命令前缀：`Bash(npm test:*)` —— 命令等于前缀或以「前缀+空格」开头即命中
//       · Write / Edit / NotebookEdit 用工具级规则（无 specifier）：记住即对该工具全放行
//   - 持久化到 ~/.mcc/settings.json 的 permissions.allow（对齐 CC 的 settings.json）
// 裁剪掉：deny/ask 规则、路径 glob、分层 settings、复合命令逐段规则建议。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './config.js'
import { BASH_TOOL_NAME } from './tools/BashTool/prompt.js'

const SETTINGS_PATH = join(CONFIG_DIR, 'settings.json')

// 命令前缀取到「可执行文件 + 子命令」两级的常见工具（git status / npm test / docker build …）
const SUBCOMMAND_TOOLS = new Set([
  'git', 'npm', 'pnpm', 'yarn', 'npx', 'cargo', 'go', 'docker', 'kubectl',
  'brew', 'pip', 'pip3', 'poetry', 'make', 'dotnet', 'gradle', 'mvn',
])

// 出现这些 shell 元字符说明是复合命令/重定向/命令替换，前缀规则无法安全覆盖 →
// 不提供「总是允许」，只给单次 y/N。保守但安全（对齐参考项目「复合命令不建议规则」）。
const COMPOUND_RE = /(\|\||&&|;|\||\$\(|`|<|>|\n|&)/

// 会话内生效的规则集合：启动时从磁盘载入，运行期新增会同时写回磁盘。
const sessionRules = new Set<string>()

function commandOf(input: unknown): string {
  if (input && typeof input === 'object') {
    const c = (input as Record<string, unknown>).command
    if (typeof c === 'string') return c.trim()
  }
  return ''
}

/** 从 Bash 命令推导可记忆的前缀；不可安全推导（复合命令/环境变量赋值）时返回 null */
export function getBashPrefix(command: string): string | null {
  const trimmed = command.trim()
  if (!trimmed || COMPOUND_RE.test(trimmed)) return null
  const tokens = trimmed.split(/\s+/)
  const exe = tokens[0]!
  if (exe.includes('=')) return null // FOO=bar cmd —— 首 token 是赋值，前缀无意义
  if (SUBCOMMAND_TOOLS.has(exe) && tokens[1] && !tokens[1].startsWith('-')) {
    return `${exe} ${tokens[1]}`
  }
  return exe
}

/** 拆解规则字符串为 { tool, spec }；无括号则 spec 为 null（工具级规则） */
function parseRule(rule: string): { tool: string; spec: string | null } {
  const m = rule.match(/^([^(]+)\((.*)\)$/)
  if (m) return { tool: m[1]!, spec: m[2]! }
  return { tool: rule, spec: null }
}

function ruleMatches(rule: string, toolName: string, input: unknown): boolean {
  const { tool, spec } = parseRule(rule)
  if (tool !== toolName) return false
  if (spec === null) return true // 工具级规则：该工具全放行
  if (toolName === BASH_TOOL_NAME) {
    const command = commandOf(input)
    if (spec.endsWith(':*')) {
      const prefix = spec.slice(0, -2)
      return command === prefix || command.startsWith(prefix + ' ')
    }
    return command === spec
  }
  return false
}

/** 当前工具调用是否命中某条已记住的规则 */
export function isAllowed(toolName: string, input: unknown): boolean {
  for (const rule of sessionRules) {
    if (ruleMatches(rule, toolName, input)) return true
  }
  return false
}

export type PermissionRuleOffer = { value: string; label: string }

/**
 * 计算「总是允许」时要记住的规则与展示标签；返回 null 表示本次不宜提供该选项
 * （如含 shell 操作符的 Bash 复合命令），此时确认对话只给单次 y/N。
 */
export function deriveRule(toolName: string, input: unknown): PermissionRuleOffer | null {
  if (toolName === BASH_TOOL_NAME) {
    const prefix = getBashPrefix(commandOf(input))
    if (!prefix) return null
    return { value: `${BASH_TOOL_NAME}(${prefix}:*)`, label: `\`${prefix}\` 开头的命令` }
  }
  // 文件类工具（Write/Edit/NotebookEdit）：工具级规则
  return { value: toolName, label: `所有 ${toolName} 操作` }
}

type Settings = { permissions?: { allow?: string[] } }

function readSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) return {}
  try {
    return JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) as Settings
  } catch {
    return {} // 文件损坏不致命：当作无规则，后续写入会重建
  }
}

/** 启动时载入持久化规则到会话集合 */
export function loadRulesFromDisk(): void {
  const allow = readSettings().permissions?.allow
  if (Array.isArray(allow)) {
    for (const r of allow) if (typeof r === 'string' && r) sessionRules.add(r)
  }
}

/** 新增一条 allow 规则：即时生效（会话集合）并写回 settings.json */
export function addRule(value: string): void {
  sessionRules.add(value)
  const settings = readSettings()
  settings.permissions ??= {}
  const allow = (settings.permissions.allow ??= [])
  if (!allow.includes(value)) allow.push(value)
  try {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  } catch {
    // 持久化失败不致命：本会话内规则仍生效（已在 sessionRules 中）
  }
}

/** 当前生效的规则列表（供 /permissions 展示） */
export function getRules(): string[] {
  return [...sessionRules]
}

export { SETTINGS_PATH }
