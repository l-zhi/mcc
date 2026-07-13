// 上下文用量估算与压缩决策，裁剪自参考项目 services/compact/autoCompact.ts +
// microCompact.ts 的阈值判断。
// 取舍（按你的决策）：
//   - token 计数用【字符估算】(len/4)，无状态、零成本；参考项目用真实 usage，留后续校准。
//   - 阈值用占 contextWindow 的比例：microcompact 70%、compact 85%（参考项目是
//     窗口 − 预留输出 − buffer 的绝对值，这里简化成比例）。
import type { ChatMessage } from './api.js'

// 约 4 字符/token（英文近似）。中文更接近 1.5~2 字符/token，本估算会偏低，
// 但 compact 阈值只到 85%、还有 15% 余量，偏差可接受；宁可晚压也别误伤。
const CHARS_PER_TOKEN = 4
// 每条消息的协议固定开销（role/分隔符等）粗估
const PER_MESSAGE_OVERHEAD_TOKENS = 4

export const MICROCOMPACT_RATIO = 0.7
export const COMPACT_RATIO = 0.85

export type CompactDecision = 'none' | 'microcompact' | 'compact'

function messageText(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content ?? ''
  if (Array.isArray(m.content)) {
    return m.content.map(p => (p.type === 'text' ? p.text : '[image]')).join('')
  }
  return ''
}

/** 估算整个消息数组的上下文 token 数（字符估算） */
export function estimateContextTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const m of messages) {
    chars += messageText(m).length
    // assistant 的 tool_calls（函数名 + 参数 JSON）也占上下文
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) {
        chars += tc.function.name.length + tc.function.arguments.length
      }
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + messages.length * PER_MESSAGE_OVERHEAD_TOKENS
}

// 每次请求都会带上全部工具的 JSON schema，API 把它算进 prompt_tokens，
// 但 estimateContextTokens 只看 messages。这是一笔可观的固定开销（实测约 4000
// tokens），不计入会让估算严重偏低、阈值偏晚。调用方把工具开销作为 extraTokens 传入。
/** 剩余上下文占比（0~100），用于状态提示 */
export function percentContextLeft(
  messages: ChatMessage[],
  contextWindow: number,
  extraTokens = 0,
): number {
  const used = estimateContextTokens(messages) + extraTokens
  return Math.max(0, Math.round(((contextWindow - used) / contextWindow) * 100))
}

/** 决定该做哪种压缩：compact（总结）优先于 microcompact（清旧工具结果） */
export function decideCompaction(
  messages: ChatMessage[],
  contextWindow: number,
  extraTokens = 0,
): CompactDecision {
  const tokens = estimateContextTokens(messages) + extraTokens
  if (tokens >= contextWindow * COMPACT_RATIO) return 'compact'
  if (tokens >= contextWindow * MICROCOMPACT_RATIO) return 'microcompact'
  return 'none'
}
