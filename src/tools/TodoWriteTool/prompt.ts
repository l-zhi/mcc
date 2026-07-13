// 工具描述文案，裁剪改编自参考项目 src/tools/TodoWriteTool/prompt.ts。
// 保留：何时用/何时不用、状态机（pending/in_progress/completed）、
//      「同一时刻只保留一个 in_progress」「完成即时标记」等核心规矩。
// 改动点：去掉参考项目里 V2/依赖关系/多代理 owner 相关表述（mini 只有 V1 内存清单）。

export const TODO_WRITE_TOOL_NAME = 'TodoWrite'

export const DESCRIPTION =
  'Create and manage a structured todo list for the current session to track progress.'

export const PROMPT = `Use this tool to create and manage a structured task list for your current work session. It helps you track progress and gives the user visibility into what you are doing.

## When to use this tool
Use it proactively for:
- Complex multi-step tasks (3 or more distinct steps)
- Non-trivial tasks that need careful planning
- When the user explicitly asks for a todo list
- When the user provides multiple tasks (a numbered or comma-separated list)
- After receiving new instructions — capture the requirements as todos
- After completing a task — mark it completed and add any follow-ups

## When NOT to use this tool
Skip it when:
- There is a single, straightforward task
- The task is trivial and tracking it adds no value
- The work can be finished in fewer than 3 trivial steps
In these cases just do the work directly.

## How it works
- This tool REPLACES the entire list each call. Always send the FULL desired list, not a diff.
- Each item has: \`content\` (imperative, e.g. "Add tests"), \`activeForm\` (present continuous, e.g. "Adding tests"), and \`status\`.

## Managing status
- Statuses: \`pending\`, \`in_progress\`, \`completed\`.
- Keep EXACTLY ONE task \`in_progress\` at a time — mark a task in_progress right before you start it.
- Mark a task \`completed\` IMMEDIATELY after finishing it; do not batch completions.
- Only mark completed when the work is fully done — if blocked or partial, keep it in_progress and add a new task describing what remains.`
