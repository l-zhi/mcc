// SendMessage 工具（多 Agent Phase 6）：给某个（通常是后台运行中的）子代理的信箱投递消息。
// 该子代理在它自己循环的下一个工具回合开头会 drain 出来、当作新指令读入。
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { sendToAgent } from '../../agents/mailbox.js'
import { getTask } from '../../agents/taskRegistry.js'
import { DESCRIPTION, PROMPT, SEND_MESSAGE_TOOL_NAME } from './prompt.js'

const inputSchema = z.object({
  to_agent_id: z.string().describe('The agentId of the target subagent (e.g. from run_in_background)'),
  message: z.string().describe('The instruction/message to deliver to that subagent'),
})

export const SendMessageTool = buildTool({
  name: SEND_MESSAGE_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return true
  },
  async call({ to_agent_id, message }): Promise<ToolResult> {
    sendToAgent(to_agent_id, message)
    const t = getTask(to_agent_id)
    if (t && t.status !== 'running') {
      return {
        content: `已投递给 ${to_agent_id}，但该后台子代理当前状态为「${t.status}」，可能不会再读取。`,
      }
    }
    return { content: `已发送给子代理 ${to_agent_id}，它会在下一步读取。` }
  },
})
