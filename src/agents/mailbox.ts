// 进程内 agent 信箱（多 Agent Phase 6）。任意发送方按 agentId 往目标 agent 的信箱塞消息；
// 目标 agent 在自己循环的每个工具回合开头 drain 自己的信箱，把消息注入成 user 消息。
// 回合制单进程：不是「事件唤醒」，而是「循环边界轮询」——只有正在跑循环的 agent 才会取到。
// 主用途：父给【正在后台跑的】子代理中途追加指令。
export const MAIN_AGENT_ID = 'main'

const inboxes = new Map<string, string[]>()

/** 往某 agent 的信箱投递一条消息 */
export function sendToAgent(agentId: string, text: string): void {
  const box = inboxes.get(agentId) ?? []
  box.push(text)
  inboxes.set(agentId, box)
}

/** 取出并清空某 agent 的信箱（供其循环开头调用） */
export function drainInbox(agentId: string): string[] {
  const box = inboxes.get(agentId)
  if (!box || box.length === 0) return []
  inboxes.set(agentId, [])
  return box
}
