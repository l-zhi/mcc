// 上下文压缩，裁剪自参考项目 services/compact/{prompt,compact,microCompact}.ts。
// 保留精华：
//   - 9 段式结构化摘要 prompt（原样搬，最有价值）+ 禁用工具的前后缀
//   - partial 压缩：总结旧消息、【保留最近 N 条原文】（切点吸附到 user 边界，不切开
//     assistant/tool_calls/tool 配对）
//   - formatCompactSummary：剥离 <analysis> 草稿、提取 <summary>
//   - microcompact：把旧的 tool 结果内容清成占位符，保留消息骨架
// 裁剪掉：fork agent、缓存、熔断、reactive(413) 重试、图片剥离、文件恢复等参考项目基础设施。
import { chatCompletion, type ChatMessage } from './api.js'
import type { Config } from './config.js'
import { estimateContextTokens } from './context.js'

// 保留最近多少条消息原文（会吸附到 user 边界，实际可能多留一点）
const PRESERVE_RECENT_MESSAGES = 6
// 微压缩保留最近多少条 tool 结果原文
const KEEP_RECENT_TOOL_RESULTS = 4
const CLEARED_PLACEHOLDER = '[旧工具结果已清理以节省上下文]'

// 禁用工具前缀：压缩是单次纯文本调用，模型若尝试调工具会浪费这唯一一轮
const NO_TOOLS_PREAMBLE = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools. You already have all the context you need in the conversation above. Your entire response must be plain text: an <analysis> block followed by a <summary> block.\n\n`

// 9 段式摘要 prompt，搬自参考 BASE_COMPACT_PROMPT（保留结构，压缩示例篇幅）
const COMPACT_PROMPT = `${NO_TOOLS_PREAMBLE}Your task is to create a detailed summary of the conversation so far, paying close attention to the user's explicit requests and your previous actions. Capture technical details, code patterns, and decisions essential for continuing the work without losing context.

Before your final summary, wrap your analysis in <analysis> tags: chronologically go through the conversation and identify the user's intents, your approach, key decisions, specific file names / code snippets / function signatures / edits, errors and how you fixed them, and any explicit user feedback.

Then provide a <summary> with these sections:
1. Primary Request and Intent: all explicit user requests and intents in detail
2. Key Technical Concepts: technologies, frameworks, patterns discussed
3. Files and Code Sections: files examined/modified/created, with why each matters and important code snippets
4. Errors and fixes: errors hit and how fixed, plus any user feedback
5. Problem Solving: problems solved and ongoing troubleshooting
6. All user messages: ALL non-tool-result user messages (critical for tracking intent)
7. Pending Tasks: tasks explicitly asked for
8. Current Work: precisely what was being worked on right before this summary, with file names/snippets
9. Optional Next Step: the next step, ONLY if directly in line with the most recent explicit request; include a verbatim quote of where you left off

Structure your output as:
<analysis>
[your thought process]
</analysis>
<summary>
1. Primary Request and Intent:
   ...
(sections 2-9)
</summary>`

/**
 * 格式化摘要：剥离 <analysis> 草稿、把 <summary> 标签换成可读标题。
 * 搬自参考 formatCompactSummary。
 */
export function formatCompactSummary(summary: string): string {
  let out = summary.replace(/<analysis>[\s\S]*?<\/analysis>/, '')
  const m = out.match(/<summary>([\s\S]*?)<\/summary>/)
  if (m) {
    out = out.replace(/<summary>[\s\S]*?<\/summary>/, `Summary:\n${(m[1] || '').trim()}`)
  }
  return out.replace(/\n\n+/g, '\n\n').trim()
}

// 把摘要包装成续接用的 user 消息，参考 getCompactUserSummaryMessage（suppress 版）
function summaryToUserContent(summary: string, hasPreserved: boolean): string {
  let s = `This session is continued from an earlier conversation that was compacted to save context. The summary below covers the earlier portion:\n\n${summary}`
  if (hasPreserved) {
    s += `\n\nRecent messages are preserved verbatim below.`
  }
  s += `\n\nContinue from where things left off without asking further questions. Do not acknowledge this summary or recap — resume the task directly.`
  return s
}

/**
 * 找切点：保留最近 keepRecent 条，但把切点吸附到 user 消息边界，
 * 保证保留段以 user 开头（不切开 assistant/tool_calls/tool 配对）。
 * 返回 pivot：messages.slice(1, pivot) 被总结，messages.slice(pivot) 原样保留。
 */
function findPivot(messages: ChatMessage[], keepRecent: number): number {
  const len = messages.length
  const target = len - keepRecent
  // 优先在 target 或更早处找 user 边界（保留 >= keepRecent 条）
  for (let i = Math.min(target, len - 1); i >= 1; i--) {
    if (messages[i]!.role === 'user') return i
  }
  // target 之前没有 user → 用其后的第一个 user（保留会少于 keepRecent）
  for (let i = Math.max(1, target + 1); i < len; i++) {
    if (messages[i]!.role === 'user') return i
  }
  return len // 完全没有 user 边界 → 全部总结、不保留
}

export type CompactStats = {
  summarizedCount: number
  keptCount: number
  tokensBefore: number
  tokensAfter: number
}

/**
 * partial 压缩：总结 messages[1..pivot) 为一段摘要，保留 system 与最近的原文消息。
 * 就地替换 messages（调用方持有同一引用）。无可总结内容时返回 null。
 */
export async function compactMessages(
  messages: ChatMessage[],
  config: Config,
  signal?: AbortSignal,
): Promise<CompactStats | null> {
  const system = messages[0]
  if (!system || system.role !== 'system') return null

  const tokensBefore = estimateContextTokens(messages)
  const pivot = findPivot(messages, PRESERVE_RECENT_MESSAGES)
  const toSummarize = messages.slice(1, pivot)
  const preserved = messages.slice(pivot)
  if (toSummarize.length === 0) return null // 没什么可总结

  // 单次无工具调用生成摘要：把 system + 要总结的历史 + 压缩指令发给模型
  const summaryRequest: ChatMessage[] = [
    system,
    ...toSummarize,
    { role: 'user', content: COMPACT_PROMPT },
  ]
  const resp = await chatCompletion(config, summaryRequest, [], signal)
  const formatted = formatCompactSummary(resp.content ?? '')
  if (!formatted) return null // 摘要为空（异常）→ 不动 messages，避免丢历史

  const newMessages: ChatMessage[] = [
    system,
    {
      role: 'user',
      content: summaryToUserContent(formatted, preserved.length > 0),
    },
    ...preserved,
  ]
  messages.splice(0, messages.length, ...newMessages)

  return {
    summarizedCount: toSummarize.length,
    keptCount: preserved.length,
    tokensBefore,
    tokensAfter: estimateContextTokens(messages),
  }
}

/**
 * 微压缩：把较旧的 tool 结果内容清成占位符（保留最近 KEEP_RECENT_TOOL_RESULTS 条），
 * 保留消息骨架与配对关系。就地修改 messages，返回估算释放的 token 数。
 */
export function microcompactMessages(messages: ChatMessage[]): number {
  const toolIdxs: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === 'tool') toolIdxs.push(i)
  }
  const clearCount = Math.max(0, toolIdxs.length - KEEP_RECENT_TOOL_RESULTS)
  let freedChars = 0
  for (let k = 0; k < clearCount; k++) {
    const m = messages[toolIdxs[k]!]!
    if (m.role === 'tool' && m.content !== CLEARED_PLACEHOLDER) {
      freedChars += m.content.length
      m.content = CLEARED_PLACEHOLDER
    }
  }
  return Math.ceil(freedChars / 4)
}
