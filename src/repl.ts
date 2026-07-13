// readline 朴素 REPL。Ink 终端 UI 留作后续迭代。
//
// 用「问答式循环」（rl.question）而非 for-await(rl)：因为工具确认（confirm）也要用
// rl.question 向用户提问，而 for-await 的行迭代器与 rl.question 是两个 line 消费者、
// 会互相打架。问答式循环任一时刻只有一个 question 挂起，天然无冲突。
//
// 中断（Ctrl+C）：
//   - 有正在执行的轮次 → abort 当前轮（停 LLM 请求 + 杀 bash 进程组），回到提示符
//   - 空闲在提示符 → 退出
//   两个来源都要挂：交互式编辑时 Ctrl+C 走 rl 的 'SIGINT'；执行工具（readline 暂停）时
//   走进程的 'SIGINT'。两者互斥触发，handleInterrupt 幂等，重复调用无害。
import * as readline from 'readline'
import type { ChatMessage } from './api.js'
import type { Config } from './config.js'
import { compactMessages } from './compact.js'
import { estimateContextTokens, percentContextLeft } from './context.js'
import { CONTEXT_LOG_PATH, logContext } from './contextLog.js'
import { appendProjectMemory } from './memory.js'
import { getRules, loadRulesFromDisk, SETTINGS_PATH } from './permissions.js'
import { getSystemPrompt } from './prompts.js'
import { getToolsOverheadTokens, query, type ConfirmFn } from './query.js'
import { shutdownLspServerManager } from './services/lsp/manager.js'
import { getTodos } from './tools/TodoWriteTool/store.js'
import { renderColored } from './tools/TodoWriteTool/TodoWriteTool.js'
import { Tracer } from './trace/Tracer.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

/**
 * 读一行。返回 null 表示流关闭（EOF / Ctrl+D / rl.close）或收到 signal 中断。
 * 传入 signal 时用 readline 原生的 abort 选项，abort 会自动清理挂起的 prompt。
 */
function ask(
  rl: readline.Interface,
  prompt: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve(null)
      return
    }
    let done = false
    const finish = (v: string | null): void => {
      if (done) return
      done = true
      rl.removeListener('close', onClose)
      signal?.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const onClose = (): void => finish(null)
    const onAbort = (): void => finish(null)
    rl.once('close', onClose)
    signal?.addEventListener('abort', onAbort, { once: true })
    // rl 可能在两次 ask 之间已关闭（如管道输入 EOF），此时 question 会抛
    // ERR_USE_AFTER_CLOSE —— 捕获并当作结束（resolve null）。
    try {
      if (signal) {
        rl.question(prompt, { signal }, answer => finish(answer))
      } else {
        rl.question(prompt, answer => finish(answer))
      }
    } catch {
      finish(null)
    }
  })
}

export async function startRepl(config: Config): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  const tracer = new Tracer(config)
  if (tracer.enabled) {
    console.log(`  trace:   ${tracer.viewerPath}（双击查看）`)
  }

  // 载入已记住的权限规则（用户此前选过「总是允许」的），本会话即时生效
  loadRulesFromDisk()
  const persistedRules = getRules()
  if (persistedRules.length > 0) {
    console.log(`  allow:   已加载 ${persistedRules.length} 条权限规则（/permissions 查看）`)
  }

  // 对话历史仅内存保存，退出即丢（持久化/续聊留作后续迭代）
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
  ]

  // 当前轮的中断句柄：非 null 表示有轮次在跑
  let currentAbort: AbortController | null = null
  let exiting = false

  const handleInterrupt = (): void => {
    if (currentAbort && !currentAbort.signal.aborted) {
      currentAbort.abort()
      console.log(`\n${YELLOW}⏸ 已中断，正在停止当前操作…${RESET}`)
    } else if (!exiting) {
      exiting = true
      rl.close()
    }
  }
  rl.on('SIGINT', handleInterrupt)
  process.on('SIGINT', handleInterrupt)

  console.log(`${DIM}提示：执行 Bash/Write/Edit 前会请求确认；Ctrl+C 中断当前操作。${RESET}`)

  while (true) {
    const line = await ask(rl, '> ')
    if (line === null) break // EOF / Ctrl+D / 空闲时 Ctrl+C
    const input = line.trim()
    if (!input) continue
    if (input === 'exit' || input === 'quit' || input === '/exit') break

    // /system：打印当前 system 提示词（含加载的 CLAUDE.md 记忆）
    if (input === '/system') {
      console.log(messages[0]?.content ?? '(无 system 消息)')
      continue
    }

    // /context：打印当前上下文用量快照（并记一条日志）
    if (input === '/context') {
      const overhead = getToolsOverheadTokens()
      const est = estimateContextTokens(messages) + overhead
      const pct = percentContextLeft(messages, config.contextWindow, overhead)
      console.log(
        `${DIM}上下文：${messages.length} 条消息，估算 ${est}/${config.contextWindow} tokens（含工具 schema ~${overhead}），剩余 ${pct}%${RESET}`,
      )
      console.log(`${DIM}用量日志：${CONTEXT_LOG_PATH}${RESET}`)
      logContext({ event: 'snapshot', messageCount: messages.length, estTokens: est, percentLeft: pct })
      continue
    }

    // /permissions：列出当前生效的权限规则（含从 settings.json 载入的）
    if (input === '/permissions') {
      const rules = getRules()
      if (rules.length === 0) {
        console.log(`${DIM}（暂无已记住的权限规则；执行 Bash/Write/Edit 时选「总是允许」即可添加）${RESET}`)
      } else {
        console.log(`${DIM}已记住的权限规则（${SETTINGS_PATH}）：${RESET}`)
        for (const r of rules) console.log(`  ${r}`)
      }
      continue
    }

    // /todos：打印当前会话的待办清单
    if (input === '/todos') {
      const todos = getTodos()
      if (todos.length === 0) {
        console.log(`${DIM}（当前没有待办）${RESET}`)
      } else {
        console.log(renderColored(todos))
      }
      continue
    }

    // /compact：手动压缩当前对话
    if (input === '/compact') {
      const ac = new AbortController()
      currentAbort = ac
      try {
        console.log(`${DIM}正在压缩对话…${RESET}`)
        const stats = await compactMessages(messages, config, ac.signal)
        if (stats) {
          console.log(
            `${DIM}已压缩：总结 ${stats.summarizedCount} 条、保留 ${stats.keptCount} 条，约 ${stats.tokensBefore}→${stats.tokensAfter} tokens（剩余上下文 ${percentContextLeft(messages, config.contextWindow, getToolsOverheadTokens())}%）${RESET}`,
          )
          logContext({
            event: 'compact',
            tokensBefore: stats.tokensBefore,
            tokensAfter: stats.tokensAfter,
            messageCount: messages.length,
          })
        } else {
          console.log(`${DIM}无需压缩（历史太短）${RESET}`)
        }
      } catch (error) {
        console.error(`压缩失败: ${(error as Error).message}`)
      } finally {
        currentAbort = null
      }
      continue
    }

    // `#` 前缀：追加一条项目记忆（写入 CLAUDE.md），不发给模型。
    // 重建 system 消息使新记忆当轮即生效（否则要重启才加载）。
    if (input.startsWith('#')) {
      const mem = input.slice(1).trim()
      if (!mem) {
        console.log(`${DIM}用法：# 要记住的内容${RESET}`)
        continue
      }
      const path = appendProjectMemory(mem)
      messages[0] = { role: 'system', content: getSystemPrompt(config.model) }
      console.log(`${DIM}已记录到 ${path}${RESET}`)
      continue
    }

    messages.push({ role: 'user', content: input })

    const ac = new AbortController()
    currentAbort = ac
    // 非只读工具执行前的确认：用当前轮的 signal，Ctrl+C 时确认对话也会被取消（视为拒绝）。
    // 可提供 rule 时给三选项：[y] 本次 / [a] 总是允许（记住规则）/ [n] 拒绝；否则退回 y/N。
    const confirm: ConfirmFn = async ({ toolName, summary, rule }) => {
      const prompt = rule
        ? `${YELLOW}允许运行 ${toolName}?${RESET} ${DIM}${summary}${RESET}\n  ${DIM}[y] 本次  [a] 总是允许 ${rule.label}  [n] 拒绝${RESET} (默认 n) `
        : `${YELLOW}允许运行 ${toolName}?${RESET} ${DIM}${summary}${RESET} [y/N] `
      const answer = await ask(rl, prompt, ac.signal)
      if (answer === null) return 'deny'
      const a = answer.trim().toLowerCase()
      if (rule && (a === 'a' || a === 'always')) return 'always'
      if (a === 'y' || a === 'yes') return 'once'
      return 'deny'
    }

    tracer.startTurn(input)
    try {
      const status = await query(messages, config, tracer, {
        signal: ac.signal,
        confirm,
      })
      tracer.endTurn(status)
      if (status === 'interrupted') {
        console.log(`${DIM}（已中断本轮）${RESET}`)
      }
    } catch (error) {
      const message = (error as Error).message
      console.error(`出错了: ${message}`)
      tracer.endTurn('error', message)
    } finally {
      currentAbort = null
    }
  }

  // 退出前停掉所有 LSP server 子进程，避免遗留僵尸进程
  await shutdownLspServerManager()
  console.log('Bye!')
}
