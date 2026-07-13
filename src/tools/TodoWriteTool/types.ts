// 待办清单的类型与 schema，裁剪自参考项目 src/utils/todo/types.ts。
// 只保留 V1（TodoWrite）需要的三字段：content / activeForm / status。
// 参考项目还有 id、priority、跨会话磁盘存储等（V2/多代理用），mini 一律不做。
import { z } from 'zod'

export const todoStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const todoItemSchema = z.object({
  content: z
    .string()
    .min(1)
    .describe(
      'The task, in imperative form (what needs to be done), e.g. "Run the test suite".',
    ),
  activeForm: z
    .string()
    .min(1)
    .describe(
      'The present-continuous form shown while the task is in progress, e.g. "Running the test suite".',
    ),
  status: todoStatusSchema.describe(
    'Current state: "pending" (not started), "in_progress" (actively working — keep exactly ONE at a time), or "completed" (finished).',
  ),
})

// 整表覆盖：TodoWrite 每次都用完整清单替换旧清单（V1 语义）
export const todoListSchema = z.array(todoItemSchema)

export type TodoStatus = z.infer<typeof todoStatusSchema>
export type TodoItem = z.infer<typeof todoItemSchema>
export type TodoList = TodoItem[]
