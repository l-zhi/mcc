// 待办清单的进程内单例存储。
// 参考项目把待办挂在 AppState.todos[agentId]（多会话/多代理各一份）；mini 是单会话、
// 单主循环，没有 AppState，用一个模块级单例即可。纯内存，退出即丢（无跨会话持久化）。
import type { TodoList } from './types.js'

let todos: TodoList = []

export function getTodos(): TodoList {
  return todos
}

/** 整表覆盖（V1 语义）：TodoWrite 每次传入完整清单替换旧的 */
export function setTodos(next: TodoList): void {
  todos = next
}

// ⑤ 周期性提醒的计数器：记录「距上次使用 TodoWrite 已过了几个 agent 步」。
// 对齐参考项目 TODO_REMINDER_CONFIG.TURNS_SINCE_WRITE 的思路（参考按对话轮计，
// mini 无 AppState/attachment 管线，改按主循环的 LLM 步计，语义等价：模型很久没碰
// 待办就提醒一次）。会话级单例，随进程存活。
let stepsSinceTodoWrite = 0

/** 主循环每完成一个 LLM 步调用一次 */
export function noteAgentStep(): void {
  stepsSinceTodoWrite++
}

/** TodoWrite 被使用、或已注入过提醒时调用，重置计数（后者兼作提醒冷却） */
export function resetStepsSinceTodoWrite(): void {
  stepsSinceTodoWrite = 0
}

export function getStepsSinceTodoWrite(): number {
  return stepsSinceTodoWrite
}
