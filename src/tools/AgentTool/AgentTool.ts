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
import { TODO_WRITE_TOOL_NAME } from '../TodoWriteTool/prompt.js'
import { AGENT_TOOL_NAME, DESCRIPTION, PROMPT } from './prompt.js'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

// 子代理专属系统提示词补充：贴在主系统提示词之后，交代「你是子代理、独立跑、只回一段总结」。
const SUBAGENT_ADDENDUM = `# Subagent mode
You are a subagent handling a delegated sub-task. You run with a fresh context and cannot see the calling agent's conversation, nor ask it questions. Work autonomously to complete the task in the user message. When finished, respond with a SINGLE final message that fully and clearly summarizes your findings or result — it is the only thing the calling agent receives. Keep intermediate narration out of that final message.`

const inputSchema = z.object({
  description: z
    .string()
    .describe('A short (3-5 word) description of the sub-task, for progress display'),
  prompt: z
    .string()
    .describe('The full, standalone task for the subagent (it cannot see this conversation)'),
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
  async call({ description, prompt }, ctx?: ToolContext): Promise<ToolResult> {
    const config = ctx?.config
    if (!config) {
      return { content: 'Error: Agent tool requires config in context (internal wiring issue).' }
    }
    // 防递归：子代理不得再派子代理（childTools 已排除 Agent，这里再兜一层）
    if ((ctx?.depth ?? 0) >= 1) {
      return { content: 'Error: a subagent cannot launch further subagents.' }
    }

    // 子代理工具集：排除 Agent（防递归）与 TodoWrite（待办 store 是进程内单例，
    // 避免子代理覆盖用户可见的待办清单）。
    const childTools = allTools.filter(
      t => t.name !== AGENT_TOOL_NAME && t.name !== TODO_WRITE_TOOL_NAME,
    )

    const childMessages: ChatMessage[] = [
      { role: 'system', content: `${getSystemPrompt(config.model)}\n\n${SUBAGENT_ADDENDUM}` },
      { role: 'user', content: prompt },
    ]
    // 子代理用静默 tracer（本轮不落 trace；可视化留待后续阶段）
    const childTracer = new Tracer(config, { disabled: true })

    console.log(`${DIM}⤷ 子代理启动：${description}${RESET}`)
    const status = await query(childMessages, config, childTracer, {
      tools: childTools,
      depth: (ctx?.depth ?? 0) + 1,
      signal: ctx?.signal,
      confirm: ctx?.confirm,
    })
    console.log(`${DIM}⤶ 子代理结束（${status}）：${description}${RESET}`)

    let content = lastAssistantText(childMessages)
    if (status === 'truncated') {
      content += '\n\n[注意：子代理触发了循环上限，结果可能不完整。]'
    } else if (status === 'interrupted') {
      content = '[子代理被用户中断，未完成。]'
    }
    return { content }
  },
})
