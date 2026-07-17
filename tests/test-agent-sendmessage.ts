#!/usr/bin/env -S npx tsx
// 多 Agent Phase 6：SendMessage 代理间通信（进程内）。确定性验证：
//   A) 信箱 send/drain + 按 agentId 隔离 + SendMessage 工具投递
//   B) 一个【正在跑循环】的 agent，在下一个工具回合开头 drain 自己信箱，把中途收到的
//      <agent-message> 读进上下文（= 父给运行中的子代理中途操舵）
// 不烧 token。跑法：npx tsx tests/test-agent-sendmessage.ts
import { createServer } from 'http'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { getSystemPrompt } from '../src/prompts.js'
import { query } from '../src/query.js'
import { Tracer } from '../src/trace/Tracer.js'
import { drainInbox, sendToAgent } from '../src/agents/mailbox.js'
import { SendMessageTool } from '../src/tools/SendMessageTool/SendMessageTool.js'
import { GlobTool } from '../src/tools/GlobTool/GlobTool.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}

async function main() {
  console.log('[A] 信箱与 SendMessage 工具')
  sendToAgent('a1', 'hello')
  check('drain 取回并清空', JSON.stringify(drainInbox('a1')) === JSON.stringify(['hello']))
  check('二次 drain 为空', drainInbox('a1').length === 0)
  sendToAgent('a1', 'x')
  check('按 agentId 隔离（drain 别的 agent 不受影响）', drainInbox('a2').length === 0)
  drainInbox('a1')
  await SendMessageTool.call({ to_agent_id: 'a3', message: 'via tool' })
  check('SendMessage 工具投递进目标信箱', JSON.stringify(drainInbox('a3')) === JSON.stringify(['via tool']))

  console.log('\n[B] 运行中的 agent 中途收信并读入')
  const captured: { messages: ChatMessage[] }[] = []
  let n = 0
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as { messages: ChatMessage[] }
      captured.push(body)
      n++
      let message: Record<string, unknown>
      if (n === 1) {
        // 模拟「父在子代理跑第 1 轮时发来一条指令」
        sendToAgent('c1', 'STEER: 记得也提到 FOO')
        // 返回一个只读工具调用，强制进入第 2 轮（下一轮开头会 drain 信箱）
        message = { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*.md' }) } }] }
      } else {
        const sawSteer = body.messages.some(m => String(m.content).includes('STEER: 记得也提到 FOO'))
        message = { role: 'assistant', content: sawSteer ? 'GOT_STEER' : 'NO_STEER' }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  const config: Config = { apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock', contextWindow: 128_000, maxTokens: 16_384 }

  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
    { role: 'user', content: '做一个多步任务' },
  ]
  const status = await query(messages, config, new Tracer(config, { disabled: true }), {
    tools: [GlobTool],
    depth: 1,
    agentId: 'c1',
  })
  server.close()

  check('本轮 ok', status === 'ok', status)
  check('第 2 轮请求里出现 <agent-message>',
    captured[1]?.messages.some(m => String(m.content).includes('<agent-message>')) === true)
  check('中途指令被读入（模型看到 STEER）',
    [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content === 'GOT_STEER')

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
