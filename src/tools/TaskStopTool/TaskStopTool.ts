// TaskStop 工具（多 Agent Phase 5）：按 agentId 中止正在运行的后台子代理。
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { stopTask } from '../../agents/taskRegistry.js'
import { DESCRIPTION, PROMPT, TASK_STOP_TOOL_NAME } from './prompt.js'

const inputSchema = z.object({
  task_id: z.string().describe('The agentId of the background subagent to stop'),
})

export const TaskStopTool = buildTool({
  name: TASK_STOP_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  // 仅中止后台任务、无文件副作用；免确认。
  isReadOnly() {
    return true
  },
  async call({ task_id }): Promise<ToolResult> {
    const t = stopTask(task_id)
    if (!t) {
      return { content: `Error: no background task with id "${task_id}".` }
    }
    return { content: `已停止后台子代理 ${task_id}（${t.description}）。` }
  },
})
