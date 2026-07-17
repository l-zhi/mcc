export const SEND_MESSAGE_TOOL_NAME = 'SendMessage'

export const DESCRIPTION = 'Send a message/instruction to a running background subagent by its agentId.'

export const PROMPT = `Send a message to a background subagent that is still running, to steer or add to its task mid-run.

Pass the \`to_agent_id\` (the agentId you got when launching it via the Agent tool's \`run_in_background\`) and the \`message\`. The subagent picks the message up on its NEXT step and treats it as a new instruction from you. Use it when you want to adjust or extend a task you already delegated without waiting for it to finish.

Note: the subagent only reads its inbox while it is running — a message to a finished subagent won't be seen.`
