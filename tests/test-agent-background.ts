#!/usr/bin/env -S npx tsx
// 多 Agent Phase 5：后台异步子代理 + 通知回推。用本地 mock 服务器确定性验证：
//   A) run_in_background 立即返回 agentId（父不阻塞），后台子代理独立跑到完成
//   B) 完成后 <task-notification> 能注入父上下文（仅顶层），且只通知一次
//   C) TaskStop 能按 id 中止后台任务
// 不烧 token。跑法：npx tsx tests/test-agent-background.ts
import { createServer } from 'http'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { getSystemPrompt } from '../src/prompts.js'
import { maybeInjectTaskNotifications, query } from '../src/query.js'
import { Tracer } from '../src/trace/Tracer.js'
import { completeTask, getTask, newTaskId, registerTask } from '../src/agents/taskRegistry.js'
import { TaskStopTool } from '../src/tools/TaskStopTool/TaskStopTool.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}
const SUMMARY = 'BG_SUMMARY: 主循环最多 20 轮。'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms = 2000): Promise<boolean> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) return false
    await sleep(20)
  }
  return true
}

async function main() {
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: ChatMessage[]; tools?: { function: { name: string } }[] }
      const hasAgent = (body.tools ?? []).some(t => t.function.name === 'Agent')
      const delegated = body.messages.some(m => m.role === 'tool')
      let message: Record<string, unknown>
      if (!hasAgent) {
        message = { role: 'assistant', content: SUMMARY } // 后台子代理：直接给最终总结
      } else if (!delegated) {
        message = {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: '后台调研', prompt: '读 src/query.ts 总结', run_in_background: true }) } }],
        }
      } else {
        message = { role: 'assistant', content: 'PARENT_DONE' } // 父没等后台，直接收尾
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  const config: Config = { apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock', contextWindow: 128_000, maxTokens: 16_384 }

  console.log('[A] 非阻塞启动 + 后台跑到完成')
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
    { role: 'user', content: '后台派一个子代理调研主循环' },
  ]
  const status = await query(messages, config, new Tracer(config, { disabled: true }), {})
  check('父本轮 ok', status === 'ok', status)
  const toolMsg = messages.find(m => m.role === 'tool')
  const toolContent = String(toolMsg?.content ?? '')
  check('Agent 结果立即返回 agentId（未阻塞等结果）', /agentId=bg_\d+/.test(toolContent))
  check('Agent 结果里没有子代理的总结（非阻塞证据）', !toolContent.includes(SUMMARY))
  check('父最终 PARENT_DONE', [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content === 'PARENT_DONE')

  const id = toolContent.match(/agentId=(bg_\d+)/)?.[1] ?? ''
  const done = await waitFor(() => getTask(id)?.status === 'done')
  check('后台子代理独立跑到 done', done, `status=${getTask(id)?.status}`)
  check('后台子代理结果 = 子代理总结', getTask(id)?.result === SUMMARY)
  server.close()

  console.log('\n[B] 通知回推')
  const msgsTop: ChatMessage[] = []
  const injected = maybeInjectTaskNotifications(msgsTop, 0)
  check('顶层注入了 1 条通知', injected === 1, `injected=${injected}`)
  check('注入的是 <task-notification> user 消息', msgsTop[0]?.role === 'user' && String(msgsTop[0]?.content).includes('<task-notification>'))
  check('通知里带回子代理结果', String(msgsTop[0]?.content).includes(SUMMARY))
  check('同一任务只通知一次（第二次 0 条）', maybeInjectTaskNotifications([], 0) === 0)

  // depth 保护：子代理（depth>0）不收后台通知
  const id2 = newTaskId()
  registerTask(id2, '另一个后台任务', new AbortController())
  completeTask(id2, 'X', 'done')
  check('子代理（depth=1）不注入通知', maybeInjectTaskNotifications([], 1) === 0)
  check('顶层仍会注入该任务', maybeInjectTaskNotifications([], 0) === 1)

  console.log('\n[C] TaskStop 中止')
  const id3 = newTaskId()
  const ac = new AbortController()
  registerTask(id3, '长任务', ac)
  const stopRes = await TaskStopTool.call({ task_id: id3 })
  check('TaskStop 返回成功文案', stopRes.content.includes(id3))
  check('任务状态变 stopped', getTask(id3)?.status === 'stopped')
  check('任务信号被 abort', ac.signal.aborted === true)
  const stopMiss = await TaskStopTool.call({ task_id: 'bg_9999' })
  check('停止未知 id 返回错误', stopMiss.content.includes('no background task'))

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
