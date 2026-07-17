// 后台任务注册表（多 Agent Phase 5）。进程内单例，登记后台子代理的状态/中止句柄/结果。
// 「已结束但还没通知父代理」的任务由主循环的注入点取走，以 <task-notification> 回推。
// 对齐参考项目 LocalAgentTask + enqueueAgentNotification 的最小切片：单进程 + AbortController + 通知回推。
export type BgStatus = 'running' | 'done' | 'error' | 'stopped'

export type BgTask = {
  id: string
  description: string
  status: BgStatus
  abort: AbortController
  result?: string
  /** 是否已把「结束」推给父代理，避免重复通知 */
  notified: boolean
}

let counter = 0
const tasks = new Map<string, BgTask>()

export function newTaskId(): string {
  return `bg_${++counter}`
}

export function registerTask(id: string, description: string, abort: AbortController): BgTask {
  const t: BgTask = { id, description, status: 'running', abort, notified: false }
  tasks.set(id, t)
  return t
}

export function completeTask(id: string, result: string, status: BgStatus): void {
  const t = tasks.get(id)
  if (!t || t.status === 'stopped') return // 已被中止 → 忽略迟到的完成
  t.status = status
  t.result = result
}

export function getTask(id: string): BgTask | undefined {
  return tasks.get(id)
}

/** 按 id 停止后台任务（abort 其信号）；返回该任务或 undefined（无此 id） */
export function stopTask(id: string): BgTask | undefined {
  const t = tasks.get(id)
  if (!t) return undefined
  if (t.status === 'running') {
    t.status = 'stopped'
    t.abort.abort()
  }
  return t
}

/** 取出「已结束但还没通知」的任务，并标记为已通知（供主循环注入点调用） */
export function takePendingNotifications(): BgTask[] {
  const out: BgTask[] = []
  for (const t of tasks.values()) {
    if (!t.notified && t.status !== 'running') {
      t.notified = true
      out.push(t)
    }
  }
  return out
}
