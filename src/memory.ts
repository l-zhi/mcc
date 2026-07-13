// 记忆管理，裁剪自参考项目 src/utils/claudemd.ts 的 CLAUDE.md 分层加载。
// 成熟实现常分多层（系统级、用户级、项目级目录树遍历 + rules 目录 + @import）；
// mini 保留最实用的两层：
//   - User 记忆：~/.mcc/CLAUDE.md（跨项目私有）
//   - Project 记忆：<cwd>/CLAUDE.md（随项目走）
// 裁剪掉：系统级层、目录树向上遍历、rules 目录、@file 导入、settings 排除规则。
import { appendFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './config.js'

const USER_MEMORY_PATH = join(CONFIG_DIR, 'CLAUDE.md')

// 项目记忆按调用时的 cwd 解析（Bash 的 cd 会改 process.cwd，这里跟随）
function projectMemoryPath(): string {
  return join(process.cwd(), 'CLAUDE.md')
}

export type MemorySource = { label: string; path: string; content: string }

/** 读取存在且非空的记忆文件（User 在前、Project 在后） */
export function loadMemories(): MemorySource[] {
  const sources: MemorySource[] = []
  const candidates: [string, string][] = [
    ['User', USER_MEMORY_PATH],
    ['Project', projectMemoryPath()],
  ]
  for (const [label, path] of candidates) {
    if (!existsSync(path)) continue
    const content = readFileSync(path, 'utf8').trim()
    if (content) sources.push({ label, path, content })
  }
  return sources
}

/** 拼成注入系统提示的一段文本；无记忆时返回空串 */
export function formatMemoriesForPrompt(): string {
  const sources = loadMemories()
  if (sources.length === 0) return ''
  return sources
    .map(s => `## ${s.label} memory — ${s.path}\n${s.content}`)
    .join('\n\n')
}

/**
 * 追加一条项目记忆（对齐参考项目的 `#` 快捷记忆）。
 * 以 bullet 追加到 <cwd>/CLAUDE.md，文件不存在则带标题创建。返回写入路径。
 */
export function appendProjectMemory(text: string): string {
  const path = projectMemoryPath()
  const line = text.trim()
  const prefix = existsSync(path) ? '' : '# Project memory\n\n'
  appendFileSync(path, `${prefix}- ${line}\n`, 'utf8')
  return path
}
