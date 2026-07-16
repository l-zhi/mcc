// Agent 主循环：发请求 → 模型返回 tool_calls → 执行工具 → 结果以 role:"tool"
// 回填 → 再发请求……直到模型返回纯文本或达到循环上限。
import { chatCompletion, type ChatMessage, type ToolCall } from './api.js'
import { isMemoryWrite } from './autoMemory.js'
import { compactMessages, microcompactMessages } from './compact.js'
import type { Config } from './config.js'
import { decideCompaction, estimateContextTokens } from './context.js'
import { logContext, percentLeftOf } from './contextLog.js'
import { addRule, deriveRule, isAllowed, type PermissionRuleOffer } from './permissions.js'
import { toOpenAIToolSpec, type Tool } from './Tool.js'
import type { TracedMessage } from './trace/types.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { TodoWriteTool, renderPlain } from './tools/TodoWriteTool/TodoWriteTool.js'
import { TODO_WRITE_TOOL_NAME } from './tools/TodoWriteTool/prompt.js'
import {
  getStepsSinceTodoWrite,
  getTodos,
  noteAgentStep,
  resetStepsSinceTodoWrite,
} from './tools/TodoWriteTool/store.js'
import type { Tracer } from './trace/Tracer.js'

/** 单个用户输入内的工具循环上限，防止模型陷入无限读文件循环 */
const MAX_TOOL_ITERATIONS = 20

// ⑤ 周期性 TodoWrite 提醒：本轮已在动手（有过工具调用）、且距上次使用 TodoWrite
// 已过这么多 LLM 步，就注入一条 <system-reminder> 把模型拉回逐步跟踪的节奏。
// 对齐参考项目 TODO_REMINDER_CONFIG（参考按对话轮，mini 按主循环步，见 store.ts）。
export const STEPS_SINCE_TODOWRITE_THRESHOLD = 3

const TODO_REMINDER_TEXT =
  "The TodoWrite tool hasn't been used in a while. If you're in the middle of multi-step work, keep the todo list current: exactly one task in_progress, and mark tasks completed IMMEDIATELY as you finish them (don't batch, don't jump ahead). This is just a gentle reminder — ignore it if it's not relevant. Do NOT mention this reminder to the user."

/**
 * ⑤ 判断并（就地）注入 TodoWrite 提醒。仅在本轮已有工具活动时才提醒（纯对话不打扰）。
 * 注入后重置计数兼作冷却。返回是否注入了（供日志）。
 */
export function maybeInjectTodoReminder(
  messages: ChatMessage[],
  toolCallsThisTurn: number,
): boolean {
  if (toolCallsThisTurn === 0) return false
  if (getStepsSinceTodoWrite() < STEPS_SINCE_TODOWRITE_THRESHOLD) return false
  const todos = getTodos()
  const listText = todos.length ? `\n\nCurrent todo list:\n${renderPlain(todos)}` : ''
  messages.push({
    role: 'user',
    content: `<system-reminder>\n${TODO_REMINDER_TEXT}${listText}\n</system-reminder>`,
  })
  resetStepsSinceTodoWrite() // 冷却：再过阈值步才会重新提醒
  return true
}

/** 确认对话的一次请求：工具名 + 输入摘要 + 可选的「总是允许」规则 */
export type ConfirmRequest = {
  toolName: string
  summary: string
  /** 可记忆的规则；为 null 时确认对话只提供单次 y/N（如 Bash 复合命令） */
  rule: PermissionRuleOffer | null
}

/** 用户对一次确认的选择：本次放行 / 记住并放行 / 拒绝 */
export type ConfirmDecision = 'once' | 'always' | 'deny'

/**
 * 权限确认回调：非只读工具执行前询问用户是否放行。
 * 由 REPL 提供实现（readline 问答）。
 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<ConfirmDecision>

export type QueryOptions = {
  /** 当前轮的中断信号，Ctrl+C 时 abort */
  signal?: AbortSignal
  /** 非只读工具的确认回调；不提供则一律放行（如管道/非交互模式） */
  confirm?: ConfirmFn
  /** 本轮循环使用的工具集；不传则用全量 allTools。子代理用它跑受限工具集。 */
  tools?: Tool[]
  /** 递归深度：主循环 0，子代理 1。用于并发/递归护栏。 */
  depth?: number
}

/** 为确认对话生成一行简短的输入摘要 */
function summarizeToolInput(input: unknown): string {
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    if (typeof o.command === 'string') return o.command
    if (typeof o.file_path === 'string') return o.file_path
  }
  const s = JSON.stringify(input)
  return s.length > 120 ? s.slice(0, 120) + '…' : s
}

export const allTools: Tool[] = [
  FileReadTool,
  FileWriteTool,
  FileEditTool,
  GrepTool,
  GlobTool,
  NotebookEditTool,
  LSPTool,
  BashTool,
  TodoWriteTool,
  AgentTool,
]

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

// 全部工具 schema 的估算 token（每次请求固定带上，计入上下文用量）。
// 工具集固定，缓存一次即可。
let _toolsOverhead: number | undefined
export function getToolsOverheadTokens(): number {
  if (_toolsOverhead === undefined) {
    const specs = allTools.map(toOpenAIToolSpec)
    _toolsOverhead = Math.ceil(JSON.stringify(specs).length / 4)
  }
  return _toolsOverhead
}

// trace 里每条消息内容的最大字符数（工具结果/文件可能很大）
const TRACE_MSG_PREVIEW = 4000

function tracedContent(m: ChatMessage): string {
  if (typeof m.content === 'string') return m.content ?? ''
  if (Array.isArray(m.content)) {
    return m.content.map(p => (p.type === 'text' ? p.text : '[image]')).join('')
  }
  return ''
}

/** 把发出的消息转成 trace 展示用的精简形式（内容截断） */
function toTracedMessages(messages: ChatMessage[]): TracedMessage[] {
  return messages.map(m => {
    const content = tracedContent(m)
    const t: TracedMessage = {
      role: m.role,
      content:
        content.length > TRACE_MSG_PREVIEW
          ? content.slice(0, TRACE_MSG_PREVIEW) + '…[truncated]'
          : content,
    }
    if (m.role === 'assistant' && m.tool_calls) {
      t.toolCalls = m.tool_calls.map(tc => ({
        name: tc.function.name,
        args: tc.function.arguments.slice(0, TRACE_MSG_PREVIEW),
      }))
    }
    if (m.role === 'tool') t.toolCallId = m.tool_call_id
    return t
  })
}

function printToolUse(toolCall: ToolCall): void {
  console.log(`${DIM}⏺ ${toolCall.function.name}(${toolCall.function.arguments})${RESET}`)
}

async function runToolCall(
  toolCall: ToolCall,
  tools: Tool[],
  config: Config,
  opts: QueryOptions,
): Promise<{ content: string; newMessages: ChatMessage[]; isError: boolean }> {
  const tool = tools.find(t => t.name === toolCall.function.name)
  if (!tool) {
    return {
      content: `Error: unknown tool "${toolCall.function.name}"`,
      newMessages: [],
      isError: true,
    }
  }

  let rawInput: unknown
  try {
    rawInput = JSON.parse(toolCall.function.arguments || '{}')
  } catch {
    return {
      content: `Error: tool arguments are not valid JSON: ${toolCall.function.arguments}`,
      newMessages: [],
      isError: true,
    }
  }

  const parsed = tool.inputSchema.safeParse(rawInput)
  if (!parsed.success) {
    // 校验失败作为 tool 结果回给模型，让它自己修正参数重试
    return {
      content: `Error: invalid tool input: ${parsed.error.message}`,
      newMessages: [],
      isError: true,
    }
  }

  // 权限门：只读工具（Read/Grep/Glob/LSP）自动放行；非只读工具（Bash/Write/Edit）
  // 执行前请用户确认。用户拒绝则作为 tool 结果回给模型，不执行。
  // 例外：
  //   - 命中已记住的 allow 规则（用户此前选过「总是允许」）→ 自动放行。
  //   - 写入自动记忆目录免确认（否则模型每存一条记忆都打断用户）。
  //   - TodoWrite 只改进程内待办 store、无外部副作用，同样免确认（否则每次勾进度都打断）。
  const noConfirmNeeded = isMemoryWrite(parsed.data) || tool.name === TODO_WRITE_TOOL_NAME
  if (!tool.isReadOnly() && opts.confirm && !noConfirmNeeded && !isAllowed(tool.name, parsed.data)) {
    const rule = deriveRule(tool.name, parsed.data)
    const decision = await opts.confirm({
      toolName: tool.name,
      summary: summarizeToolInput(parsed.data),
      rule,
    })
    if (decision === 'deny') {
      return {
        content:
          '用户拒绝执行该工具。请勿重试此操作；如仍需继续，请询问用户或改用其他方式。',
        newMessages: [],
        isError: true,
      }
    }
    // 「总是允许」：记住规则（写回 settings.json），后续同类调用自动放行
    if (decision === 'always' && rule) addRule(rule.value)
  }

  try {
    const result = await tool.call(parsed.data, {
      signal: opts.signal,
      config,
      confirm: opts.confirm,
      depth: opts.depth ?? 0,
    })
    return {
      content: result.content,
      newMessages: result.newMessages ?? [],
      isError: false,
    }
  } catch (error) {
    return {
      content: `Error: ${(error as Error).message}`,
      newMessages: [],
      isError: true,
    }
  }
}

/**
 * 处理一轮用户输入。messages 会被原地追加（assistant / tool / 注入的 user 消息），
 * 由调用方（REPL）持有以维持对话历史。tracer 记录每次 LLM 调用与工具调用的耗时/token。
 * 返回本轮的收尾状态：
 *   'ok'          模型给出纯文本
 *   'truncated'   触发循环上限
 *   'interrupted' 用户 Ctrl+C 中断
 */
export async function query(
  messages: ChatMessage[],
  config: Config,
  tracer: Tracer,
  opts: QueryOptions = {},
): Promise<'ok' | 'truncated' | 'interrupted'> {
  const { signal } = opts
  // 本轮工具集：子代理传受限集合，否则用全量 allTools
  const tools = opts.tools ?? allTools
  const toolSpecs = tools.map(toOpenAIToolSpec)
  // 工具 schema 开销（计入上下文估算）。按本轮实际工具集算，子代理集合更小也准确。
  const toolsOverhead = Math.ceil(JSON.stringify(toolSpecs).length / 4)
  // 本轮已执行的工具调用数：⑤ 提醒只在模型确实在动手时才触发，纯对话不打扰
  let toolCallsThisTurn = 0

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (signal?.aborted) return 'interrupted'

    // ⑤ 距上次 TodoWrite 太久且本轮在动手 → 注入 system-reminder 拉回逐步节奏
    if (maybeInjectTodoReminder(messages, toolCallsThisTurn)) {
      logContext({ event: 'todo_reminder', messageCount: messages.length })
    }

    // 上下文管理：调模型前检查用量。compact（总结）优先于 microcompact（清旧工具结果）。
    // compact 自身是一次直调 chatCompletion（无工具），不走 query，不会递归触发。
    // 估算要加上工具 schema 开销（toolsOverhead，本轮工具集算一次），否则会严重偏低。
    const decision = decideCompaction(messages, config.contextWindow, toolsOverhead)
    if (decision === 'compact') {
      console.log(`${DIM}⚡ 上下文接近上限，正在压缩对话…${RESET}`)
      try {
        const stats = await compactMessages(messages, config, signal)
        if (stats) {
          console.log(
            `${DIM}  已压缩：总结 ${stats.summarizedCount} 条、保留 ${stats.keptCount} 条，约 ${stats.tokensBefore}→${stats.tokensAfter} tokens${RESET}`,
          )
          logContext({
            event: 'compact',
            tokensBefore: stats.tokensBefore,
            tokensAfter: stats.tokensAfter,
            messageCount: messages.length,
          })
        }
      } catch (error) {
        if (signal?.aborted) return 'interrupted'
        // 压缩失败不致命：记录后继续（下一步真实请求可能仍然过大）
        console.error(`${DIM}  压缩失败，继续本轮：${(error as Error).message}${RESET}`)
      }
    } else if (decision === 'microcompact') {
      const freed = microcompactMessages(messages)
      if (freed > 0) {
        console.log(`${DIM}⚡ 已清理旧工具结果，约释放 ${freed} tokens${RESET}`)
        logContext({ event: 'microcompact', freedTokens: freed, messageCount: messages.length })
      }
    }

    // 调模型前的字符估算（含工具开销，与 decideCompaction 同口径）
    const estBefore = estimateContextTokens(messages) + toolsOverhead

    // 快照本次实际发出的请求（trace 用）：system 单独存、其余作为历史消息。
    // 必须在收到响应 push 之前取，才是「发出去的原样」。仅 trace 开启时构建。
    const traceSystemPrompt =
      tracer.enabled && typeof messages[0]?.content === 'string'
        ? (messages[0].content as string)
        : undefined
    const traceRequest = tracer.enabled
      ? toTracedMessages(messages.slice(1))
      : undefined

    const llmStart = Date.now()
    let response
    try {
      response = await chatCompletion(config, messages, toolSpecs, signal)
    } catch (error) {
      // abort 期间 fetch 抛错属预期中断，非真错误
      if (signal?.aborted) return 'interrupted'
      throw error
    }
    const llmDuration = Date.now() - llmStart
    // ⑤ 记一个 agent 步：距上次 TodoWrite 的步数 +1
    noteAgentStep()

    // 记录本次调用的上下文用量：估算 vs API 真实 prompt_tokens，方便对比与测试
    const realTokens = response.usage?.prompt_tokens
    logContext({
      event: 'llm_call',
      messageCount: messages.length,
      estTokens: estBefore,
      realTokens,
      percentLeft: percentLeftOf(realTokens ?? estBefore, config.contextWindow),
    })

    messages.push({
      role: 'assistant',
      content: response.content,
      ...(response.tool_calls?.length && { tool_calls: response.tool_calls }),
    })

    // 结束原因：优先用端点返回的真实 finish_reason；缺失时回落到「有无 tool_calls」推导
    const finishReason =
      response.finish_reason ?? (response.tool_calls?.length ? 'tool_calls' : 'stop')
    tracer.recordStep(
      {
        durationMs: llmDuration,
        tokens: response.usage && {
          prompt: response.usage.prompt_tokens,
          completion: response.usage.completion_tokens,
        },
        content: response.content ?? '',
        finishReason,
      },
      {
        request: traceRequest,
        systemPrompt: traceSystemPrompt,
        toolNames: toolSpecs.map(t => t.function.name),
      },
    )

    if (response.content) {
      console.log(response.content)
    }

    // 撞到 max_tokens 被截断：输出不完整。
    //   - 纯文本被截断 → 注入「接着写」提示并继续本轮循环（受 MAX_TOOL_ITERATIONS 约束），
    //     把分段的回答续完。
    //   - 工具调用被截断 → 其 arguments 多半是坏 JSON，会走下面 runToolCall 的解析报错
    //     让模型自行重试；这里只给一句可见告警。
    if (finishReason === 'length') {
      console.warn(
        `${DIM}⚠ 输出撞到 max_tokens（${config.maxTokens}）被截断。${response.tool_calls?.length ? '工具调用可能不完整，将让模型重试。' : '正在让模型接着写…'}${RESET}`,
      )
      if (!response.tool_calls?.length) {
        messages.push({
          role: 'user',
          content:
            'Your previous message was cut off because it hit the output token limit. Continue exactly where you left off — do not repeat what you already wrote, and do not restart.',
        })
        continue
      }
    }

    if (!response.tool_calls?.length) {
      return 'ok'
    }

    // OpenAI 协议要求 assistant 消息之后紧跟每个 tool_call 的 role:"tool" 回复，
    // 其他消息（图片注入的 user 消息）必须排在所有 tool 消息之后。
    const injected: ChatMessage[] = []
    let interrupted = false
    for (const toolCall of response.tool_calls) {
      // 已中断：为剩余 tool_call 补占位结果，保证协议完整性
      // （assistant.tool_calls 的每一项都必须有对应的 tool 消息，否则下轮请求会被拒）
      if (interrupted || signal?.aborted) {
        interrupted = true
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: '已被用户中断，未执行。',
        })
        continue
      }
      printToolUse(toolCall)
      toolCallsThisTurn++
      const toolStart = Date.now()
      const { content, newMessages, isError } = await runToolCall(toolCall, tools, config, opts)
      tracer.recordToolCall({
        id: toolCall.id,
        name: toolCall.function.name,
        argumentsRaw: toolCall.function.arguments,
        durationMs: Date.now() - toolStart,
        resultContent: content,
        isError,
      })
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content })
      injected.push(...newMessages)
      if (signal?.aborted) interrupted = true
    }
    messages.push(...injected)
    if (interrupted) return 'interrupted'
  }

  console.warn(
    `已达到单轮工具循环上限（${MAX_TOOL_ITERATIONS} 次），停止本轮。请继续输入以恢复。`,
  )
  return 'truncated'
}
