export const TASK_STOP_TOOL_NAME = 'TaskStop'

export const DESCRIPTION = 'Stop a running background subagent by its agentId.'

export const PROMPT = `Stop a background subagent that is still running.

Pass the \`task_id\` (the agentId you got back when you launched it with the Agent tool's \`run_in_background\`). This aborts the subagent; you will not receive its result. Use it when a background task is no longer needed or is taking too long.`
