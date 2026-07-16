export const AGENT_TOOL_NAME = 'Agent'

export const DESCRIPTION =
  'Delegate a self-contained task to a subagent that runs in its own fresh context and returns a single summary.'

export const PROMPT = `Launch a subagent to handle a self-contained task autonomously.

## How it works
- The subagent starts with a FRESH, empty context — it cannot see this conversation. It only receives the \`prompt\` you give it.
- It runs its own agent loop (reading files, searching, etc.) to completion, then returns a SINGLE final message summarizing what it found or did.
- Its intermediate steps and tool output do NOT enter your context — you only pay for the final summary. This is the point: use it to explore widely without flooding your own context.
- The subagent runs to completion in one shot: it cannot ask you follow-up questions, and you cannot steer it mid-run.
- A subagent cannot launch further subagents.

## When to use it
- Open-ended search/research spanning many files where you only need the conclusion ("find everywhere X is used and summarize the pattern").
- A chunky, well-scoped sub-task you can describe completely up front.

## When NOT to use it
- Small or direct tasks — just use Read/Grep/Glob yourself; the round-trip isn't worth it.
- Anything needing back-and-forth or your ongoing judgement.

## Writing the prompt
Because the subagent can't see this conversation, the \`prompt\` must be fully standalone: state the goal, any paths/context it needs, and exactly what to return. Its final message is the only thing you get back, and it is not shown to the user.`
