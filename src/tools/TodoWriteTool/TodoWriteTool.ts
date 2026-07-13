// TodoWrite 工具（Phase 1，系统 A 待办清单 V1），裁剪自参考项目 src/tools/TodoWriteTool。
// 语义：整表覆盖写入进程内 store（store.ts），无磁盘、无跨会话、无依赖关系（那些是 V2/系统 C）。
// 权限：isReadOnly()=false（它确实改状态，便于 Phase 2 子代理工具过滤时识别），
//      但因只改进程内 store、无外部副作用，query 层对它免确认（见 query.ts 的权限门）。
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { logEventStub } from '../../stubs.js'
import { resetStepsSinceTodoWrite, setTodos } from './store.js'
import { DESCRIPTION, PROMPT, TODO_WRITE_TOOL_NAME } from './prompt.js'
import { todoListSchema, type TodoItem, type TodoList } from './types.js'

const inputSchema = z.object({
  todos: todoListSchema.describe(
    'The complete, updated todo list. This REPLACES the entire previous list — always send every item you still want tracked.',
  ),
})

const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

/** 无色纯文本清单，回填给模型作为权威状态（避免模型漏记自己的进度） */
export function renderPlain(todos: TodoList): string {
  if (todos.length === 0) return '(todo list is empty)'
  return todos
    .map(t => {
      const box =
        t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
      const label = t.status === 'in_progress' ? t.activeForm : t.content
      return `${box} ${label}`
    })
    .join('\n')
}

/** 带色清单，打印到终端供用户看进度（对齐 mini 其余 console 进度输出的风格） */
export function renderColored(todos: TodoList): string {
  const lines = todos.map(t => {
    if (t.status === 'completed') return `${GREEN}  ☒ ${t.content}${RESET}`
    if (t.status === 'in_progress') return `${YELLOW}  → ${t.activeForm}${RESET}`
    return `${DIM}  ☐ ${t.content}${RESET}`
  })
  return lines.join('\n')
}

export const TodoWriteTool = buildTool({
  name: TODO_WRITE_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return false
  },
  async call({ todos }): Promise<ToolResult> {
    setTodos(todos)
    // ⑤ 重置「距上次 TodoWrite」计数：模型刚碰过待办，冷却周期性提醒
    resetStepsSinceTodoWrite()

    const inProgress = todos.filter((t: TodoItem) => t.status === 'in_progress')
    const completed = todos.filter((t: TodoItem) => t.status === 'completed').length

    logEventStub('todo_write', {
      total: todos.length,
      completed,
      inProgress: inProgress.length,
    })

    // 打印到终端供用户看进度
    if (todos.length > 0) {
      console.log(renderColored(todos))
    }

    // 回填给模型（④ 工具结果文案强化，对齐参考 mapToolResultToToolResultBlockParam）：
    // 权威清单 + 每次都推一把「继续逐步执行」，把模型拉回 in_progress→completed 的节奏。
    let content =
      `Todos updated (${completed}/${todos.length} completed). Continue using the todo list to track progress: work the one in_progress task next, and mark it completed IMMEDIATELY when done — do not batch completions or jump ahead. Proceed with the current task now.\n` +
      renderPlain(todos)
    if (inProgress.length > 1) {
      content += `\n\nNote: ${inProgress.length} tasks are in_progress. Keep exactly ONE in_progress at a time.`
    }
    return { content }
  },
})
