// Agent 工具（Phase 1：最小同步子代理）。
// 子代理 = 用一段全新的对话历史 + 自己的系统提示词 + 受限工具集，递归跑一遍 query()，
// 跑到收敛后只把「最后一条 assistant 文本」交回父代理——中间的工具调用/结果全部丢弃，
// 这就是上下文隔离（父只为「报告」付上下文，不为子代理的原始探索付费）。
// 对齐参考项目 runAgent + finalizeAgentTool 的最小内核。后续阶段再叠：类型注册表、并行、可视化。
import { z } from 'zod'
import type { ChatMessage } from '../../api.js'
import { buildTool, type ToolContext, type ToolResult } from '../../Tool.js'
import { getSystemPrompt } from '../../prompts.js'
import { Tracer } from '../../trace/Tracer.js'
// 运行时才用到 query/allTools（在 call 里），可安全跨越与 query.ts 的循环引用
import { allTools, query } from '../../query.js'
import {
  DEFAULT_AGENT_TYPE,
  getAgentDefinition,
  getAgentDefinitions,
} from '../../agents/registry.js'
import { completeTask, newTaskId, registerTask } from '../../agents/taskRegistry.js'
import { TODO_WRITE_TOOL_NAME } from '../TodoWriteTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../TaskStopTool/prompt.js'
import { SEND_MESSAGE_TOOL_NAME } from '../SendMessageTool/prompt.js'
import { AGENT_TOOL_NAME, DESCRIPTION, PROMPT } from './prompt.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

const inputSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the sub-task, for progress display'),
  prompt: z
    .string()
    .describe('The full, standalone task for the subagent (it cannot see this conversation)'),
  subagent_type: z
    .string()
    .optional()
    .describe('Which agent type to use (see the list above); defaults to general-purpose'),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'If true, run the subagent in the background: returns an agentId immediately (does NOT wait), and its result is delivered later as a task-notification. Background subagents are read-only. Stop one with TaskStop.',
    ),
})

/** 从子代理跑完的消息里取「最后一条有文本的 assistant 消息」作为回传内容 */
function lastAssistantText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      return m.content.trim()
    }
  }
  return '(subagent finished without a text response)'
}

export const AgentTool = buildTool({
  name: AGENT_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  // spawn 本身是编排，无直接副作用；子代理内部的变更工具会各自走确认门，故这里免确认。
  isReadOnly() {
    return true
  },
  // 多个 Agent 调用可并发跑（各自独立上下文，互不干扰）——Phase 3 并行的开关。
  isConcurrencySafe() {
    return true
  },
  async call(
    { description, prompt, subagent_type, run_in_background },
    ctx?: ToolContext,
  ): Promise<ToolResult> {
    const config = ctx?.config
    if (!config) {
      return { content: 'Error: Agent tool requires config in context (internal wiring issue).' }
    }
    // 防递归：子代理不得再派子代理（childTools 已排除 Agent，这里再兜一层）
    if ((ctx?.depth ?? 0) >= 1) {
      return { content: 'Error: a subagent cannot launch further subagents.' }
    }

    // 解析 subagent_type（缺省 general-purpose）；未知类型作为错误回给模型
    const type = subagent_type || DEFAULT_AGENT_TYPE
    const def = getAgentDefinition(type)
    if (!def) {
      const valid = getAgentDefinitions().map(d => d.agentType).join(', ')
      return { content: `Error: unknown subagent_type "${type}". Valid types: ${valid}.` }
    }

    // 子代理工具集：先按类型的 allowlist 过滤（未指定则全部），再统一排除编排类工具——
    // Agent（防递归）、TodoWrite（待办 store 单例）、TaskStop / SendMessage（后台任务与代理间通信由顶层编排）。
    const allowed = def.tools
    const orchestrationTools = new Set([
      AGENT_TOOL_NAME,
      TODO_WRITE_TOOL_NAME,
      TASK_STOP_TOOL_NAME,
      SEND_MESSAGE_TOOL_NAME,
    ])
    let childTools = allTools.filter(
      t => !orchestrationTools.has(t.name) && (allowed === undefined || allowed.includes(t.name)),
    )
    // 后台子代理没法弹确认框（父可能正在做别的/空闲）→ 只给只读工具，免确认、免 REPL 冲突。
    if (run_in_background) {
      childTools = childTools.filter(t => t.isReadOnly())
    }

    const childMessages: ChatMessage[] = [
      {
        role: 'system',
        content: `${getSystemPrompt(config.model)}\n\n# Subagent mode (${def.agentType})\n${def.systemPrompt}`,
      },
      { role: 'user', content: prompt },
    ]
    const childDepth = (ctx?.depth ?? 0) + 1
    const pad = '  '.repeat(childDepth)

    // Phase 5：后台异步。不 await——立即返回 agentId，结果稍后由主循环以 <task-notification> 回推。
    if (run_in_background) {
      const id = newTaskId()
      const ac = new AbortController() // 独立信号：不随父轮次结束而中止
      registerTask(id, description, ac)
      console.log(`${DIM}${pad}⇢ 后台子代理启动 [${def.agentType}] (${id})：${description}${RESET}`)
      void query(childMessages, config, new Tracer(config, { disabled: true }), {
        tools: childTools,
        depth: childDepth,
        signal: ac.signal,
        agentId: id, // 后台子代理收自己信箱（父可用 SendMessage 中途发指令）
      })
        .then(status => {
          completeTask(
            id,
            lastAssistantText(childMessages),
            status === 'ok' ? 'done' : status === 'interrupted' ? 'stopped' : 'error',
          )
          console.log(`${DIM}${pad}⇠ 后台子代理完成 (${id}，${status})：${description}${RESET}`)
        })
        .catch(e => completeTask(id, `Error: ${(e as Error).message}`, 'error'))
      return {
        content: `已在后台启动子代理，agentId=${id}。它会独立跑完，结果稍后以 task-notification 回传给你；请继续其它工作，不要等待其结果。需要时可用 TaskStop 停止它。`,
      }
    }

    // 同步：父 await 子代理跑完，拿最后一段总结回填。
    console.log(`${DIM}${pad}⤷ 子代理启动 [${def.agentType}]：${description}${RESET}`)
    const status = await query(childMessages, config, new Tracer(config, { disabled: true }), {
      tools: childTools,
      depth: childDepth,
      signal: ctx?.signal,
      confirm: ctx?.confirm,
    })
    console.log(`${DIM}${pad}⤶ 子代理结束（${status}）：${description}${RESET}`)

    let content = lastAssistantText(childMessages)
    if (status === 'truncated') {
      content += '\n\n[注意：子代理触发了循环上限，结果可能不完整。]'
    } else if (status === 'interrupted') {
      content = '[子代理被用户中断，未完成。]'
    }
    return { content }
  },
})
