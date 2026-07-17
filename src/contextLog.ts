// 上下文用量日志。上下文本身不落盘（内存里、退出即丢），这里补一条旁路日志，
// 方便测试时观察 token 增长、压缩触发、以及「字符估算」和「API 真实 usage」的偏差。
//
// - 始终追加到文件 ~/.mcc/traces/context.log（NDJSON，可 tail -f）
// - 控制台默认安静；MCC_CONTEXT_LOG=1（或 true）时每条也打印到终端
import { appendFileSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CONFIG_DIR } from './config.js'

const LOG_DIR = join(CONFIG_DIR, 'traces')
export const CONTEXT_LOG_PATH = join(LOG_DIR, 'context.log')
export const LAST_REQUEST_PATH = join(LOG_DIR, 'last-request.json')

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function consoleEnabled(): boolean {
  const v = process.env.MCC_CONTEXT_LOG
  return v === '1' || v?.toLowerCase() === 'true'
}

let ensured = false
function ensureDir(): void {
  if (ensured) return
  try {
    mkdirSync(LOG_DIR, { recursive: true })
  } catch {
    // 忽略：写日志失败不该影响主流程
  }
  ensured = true
}

export type ContextLogEntry = {
  event: 'llm_call' | 'microcompact' | 'compact' | 'snapshot' | 'todo_reminder' | 'task_notification'
  /** 当前消息条数 */
  messageCount?: number
  /** 字符估算 token（decideCompaction 用的口径） */
  estTokens?: number
  /** API 返回的真实输入 token（usage.prompt_tokens），无则缺省 */
  realTokens?: number
  /** 剩余上下文占比（基于 realTokens 优先，否则 estTokens） */
  percentLeft?: number
  /** 微压缩释放的估算 token */
  freedTokens?: number
  /** 压缩前后估算 token */
  tokensBefore?: number
  tokensAfter?: number
  note?: string
}

function formatHuman(e: ContextLogEntry): string {
  switch (e.event) {
    case 'llm_call':
    case 'snapshot':
      return (
        `${e.event === 'snapshot' ? 'snapshot' : 'llm'} ` +
        `msgs=${e.messageCount} est=${e.estTokens}` +
        (e.realTokens != null ? ` real=${e.realTokens}` : '') +
        (e.percentLeft != null ? ` left=${e.percentLeft}%` : '')
      )
    case 'microcompact':
      return `microcompact 释放~${e.freedTokens} tokens`
    case 'compact':
      return `compact ${e.tokensBefore}→${e.tokensAfter} tokens`
    case 'todo_reminder':
      return `todo_reminder 注入（msgs=${e.messageCount}）`
    case 'task_notification':
      return `task_notification 注入（msgs=${e.messageCount}）`
  }
}

export function logContext(entry: ContextLogEntry): void {
  ensureDir()
  const ts = new Date().toISOString()
  try {
    appendFileSync(CONTEXT_LOG_PATH, JSON.stringify({ ts, ...entry }) + '\n', 'utf8')
  } catch {
    // 忽略写盘错误
  }
  if (consoleEnabled()) {
    console.log(`${DIM}[ctx] ${formatHuman(entry)}${RESET}`)
  }
}

/** 基于真实/估算 token 算剩余占比（0~100） */
export function percentLeftOf(tokens: number, contextWindow: number): number {
  return Math.max(0, Math.round(((contextWindow - tokens) / contextWindow) * 100))
}

/**
 * 把即将发给模型的完整请求体（system + 全部 messages + tools，含工具 schema）
 * 覆盖写到 last-request.json，方便查看「实际发出去的提示词长什么样」。
 * 默认开启；设 MCC_DEBUG_REQUEST=0 / false 关闭。
 */
export function dumpRequestIfEnabled(body: unknown): void {
  const v = process.env.MCC_DEBUG_REQUEST
  if (v === '0' || v?.toLowerCase() === 'false') return
  ensureDir()
  try {
    writeFileSync(LAST_REQUEST_PATH, JSON.stringify(body, null, 2), 'utf8')
  } catch {
    // 忽略写盘错误
  }
}
