// 自动记忆（agent 自管理的跨会话记忆），裁剪自参考项目 src/memdir/*。
// 与参考项目一致的核心思想：无专用工具，模型用普通 Read/Write/Edit/Grep 自管理，
// 系统提示教它规矩（4 类型 + 两步存法 + 何时取），MEMORY.md 索引常驻上下文、具体记忆按需读。
// 落地取舍（按已定决策）：
//   - 目录 per-project：~/.mcc/memory/<sanitized-cwd>/（对齐 master 的 projects/<项目> 隔离）
//   - 记忆目录内的写入在 query 层免确认（否则每存一条都打断）
//   - 召回 v1 只做「索引常驻 + 按需 Read」；findRelevantMemories 关键词召回留后续
//   - 全 4 类型（user/feedback/project/reference），示例压缩
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join, sep } from 'path'
import { expandPath } from './utils/file.js'

const MEMORY_BASE = join(homedir(), '.mcc', 'memory')
const MEMORY_INDEX = 'MEMORY.md'
// MEMORY.md 常驻上下文，过长会挤占空间——超这么多行提示模型收敛（对齐 master 的 200 行上限精神）
const MAX_INDEX_LINES = 200

// 记忆目录按「启动时的 cwd」定并 memoize：Bash 的 cd 会改 process.cwd()，
// 但记忆应绑定到启动的项目，保持整个会话稳定。
let _memoryDir: string | undefined
export function getMemoryDir(): string {
  if (!_memoryDir) {
    const sanitized = process
      .cwd()
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    _memoryDir = join(MEMORY_BASE, sanitized)
  }
  return _memoryDir
}

function indexPath(): string {
  return join(getMemoryDir(), MEMORY_INDEX)
}

/** 默认开启；MCC_AUTO_MEMORY=0 / false 关闭（省 ~1500 token/请求） */
export function autoMemoryEnabled(): boolean {
  const v = process.env.MCC_AUTO_MEMORY
  return v !== '0' && v?.toLowerCase() !== 'false'
}

export function ensureMemoryDir(): void {
  try {
    mkdirSync(getMemoryDir(), { recursive: true })
  } catch {
    // 建目录失败不该影响主流程
  }
}

/** 读 MEMORY.md 索引内容；不存在/空返回 null。超行数上限则截断并附提示。 */
export function loadMemoryIndex(): string | null {
  try {
    const raw = readFileSync(indexPath(), 'utf8').trim()
    if (!raw) return null
    const lines = raw.split('\n')
    if (lines.length > MAX_INDEX_LINES) {
      return (
        lines.slice(0, MAX_INDEX_LINES).join('\n') +
        `\n… [index truncated at ${MAX_INDEX_LINES} lines — keep it concise]`
      )
    }
    return raw
  } catch {
    return null
  }
}

/** 判断某绝对路径是否在记忆目录内（用于写入免确认） */
export function isWithinMemoryDir(absolutePath: string): boolean {
  const dir = getMemoryDir()
  return absolutePath === dir || absolutePath.startsWith(dir + sep)
}

/** 判断一次工具调用是否是「写入记忆目录」（Write/Edit/NotebookEdit 的目标在记忆目录内） */
export function isMemoryWrite(input: unknown): boolean {
  if (!input || typeof input !== 'object') return false
  const o = input as Record<string, unknown>
  const p = o.file_path ?? o.notebook_path
  if (typeof p !== 'string' || !p) return false
  return isWithinMemoryDir(expandPath(p))
}

/**
 * 构建注入系统提示的自动记忆段：自管理指令 + 当前 MEMORY.md 索引。
 * 关闭时返回空串。
 */
export function buildAutoMemorySection(): string {
  if (!autoMemoryEnabled()) return ''
  ensureMemoryDir()
  const dir = getMemoryDir()
  const index = loadMemoryIndex()

  return `# Auto memory

You have a persistent, file-based memory at \`${dir}\`. Build it up over time so future conversations understand who the user is, how they like to work, what to avoid or repeat, and the context behind their work. This memory persists across sessions (unlike the conversation, which is discarded on exit).

If the user explicitly asks you to remember something, save it immediately; if they ask you to forget something, find and remove it.

## Types of memory (the frontmatter \`type\`)
- **user** — the user's role, expertise, preferences, goals. Helps you tailor how you collaborate.
- **feedback** — guidance on how you should work: corrections AND confirmed-good approaches. Include the *why*.
- **project** — ongoing work, goals, constraints, incidents not derivable from code/git. Convert relative dates to absolute (e.g. "Thursday" → "2026-07-09").
- **reference** — pointers to external resources (URLs, tickets, dashboards).

## What NOT to save
Don't save what the repo/git already records (code structure, past fixes), secrets, or anything only useful in the current conversation. When unsure it will matter next time, don't save it.

## How to save (two steps)
1. Write the memory to its own file in the memory dir, e.g. \`${dir}${sep}feedback-integration-tests.md\`, with this frontmatter:
   \`\`\`
   ---
   name: <short-kebab-slug>
   description: <one-line summary — used to judge relevance on recall>
   type: user | feedback | project | reference
   ---
   <the fact. For feedback/project, follow with **Why:** and **How to apply:** lines. Link related memories with [[other-slug]].>
   \`\`\`
2. Add a one-line pointer in \`${MEMORY_INDEX}\` (the index below, always loaded): \`- [Title](file.md) — one-line hook\`. Keep it under ~150 chars. NEVER put memory content directly in ${MEMORY_INDEX}.

Before writing, check ${MEMORY_INDEX} for an existing memory to update instead of duplicating. Remove memories that turn out to be wrong.

## When to use
${MEMORY_INDEX} is always in your context (below). When its index suggests a relevant memory, Read that file before acting. Recalled memories reflect what was true when written — verify file/flag names still exist before relying on them.

## ${MEMORY_INDEX}
${index ?? `(empty — when you save memories, their pointers will appear here)`}`
}
