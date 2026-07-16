#!/usr/bin/env -S npx tsx
// 多 Agent Phase 3：并行子代理。用一个「屏障」确定性地证明并发——两个子代理必须同时在飞，
// 屏障才会释放；若是顺序执行，第二个永远不会在第一个完成前启动，屏障靠 2s 超时兜底释放，
// 于是 maxInflight 只会是 1。断言 maxInflight===2 且未超时 = 真并发。不烧 token。
import { createServer } from 'http'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { getSystemPrompt } from '../src/prompts.js'
import { query } from '../src/query.js'
import { Tracer } from '../src/trace/Tracer.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}

async function main() {
  let inflight = 0
  let maxInflight = 0
  let timedOut = false
  let release!: () => void
  const barrier = new Promise<void>(r => (release = r))
  const timer = setTimeout(() => { timedOut = true; release() }, 2000)

  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', async () => {
      const body = JSON.parse(raw) as { messages: ChatMessage[]; tools?: { function: { name: string } }[] }
      const hasAgent = (body.tools ?? []).some(t => t.function.name === 'Agent')
      const send = (message: Record<string, unknown>): void => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
      }

      if (!hasAgent) {
        // 子代理：进入临界区，等两个都到齐（或超时）再回，据此测量并发度
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        if (inflight >= 2) release()
        await barrier
        inflight--
        const userPrompt = String(body.messages[1]?.content ?? '')
        send({ role: 'assistant', content: userPrompt.includes('PROMPT_A') ? 'SUMMARY_A' : 'SUMMARY_B' })
        return
      }
      const delegated = body.messages.some(m => m.role === 'tool')
      if (!delegated) {
        // 父第 1 次：一条消息里发两个 Agent 调用
        send({
          role: 'assistant', content: null,
          tool_calls: [
            { id: 'a1', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: '调研 A', prompt: '任务 PROMPT_A', subagent_type: 'explore' }) } },
            { id: 'a2', type: 'function', function: { name: 'Agent', arguments: JSON.stringify({ description: '调研 B', prompt: '任务 PROMPT_B', subagent_type: 'explore' }) } },
          ],
        })
      } else {
        send({ role: 'assistant', content: 'PARENT_DONE' })
      }
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port

  const config: Config = {
    apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock',
    contextWindow: 128_000, maxTokens: 16_384,
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
    { role: 'user', content: '并行派两个子代理调研 A 和 B' },
  ]
  const status = await query(messages, config, new Tracer(config, { disabled: true }), {})
  clearTimeout(timer)
  server.close()

  console.log('\n[并发证明]')
  check('两个子代理曾同时在飞（maxInflight=2）', maxInflight === 2, `maxInflight=${maxInflight}`)
  check('未触发超时兜底（即真并发释放的屏障）', timedOut === false)

  console.log('\n[结果回填]')
  check('本轮收尾 ok', status === 'ok', status)
  const toolMsgs = messages.filter(m => m.role === 'tool')
  check('父上下文有 2 条 tool 结果', toolMsgs.length === 2, `实际 ${toolMsgs.length}`)
  const contents = toolMsgs.map(m => String(m.content))
  check('两个子代理结果都回填（A 和 B）',
    contents.includes('SUMMARY_A') && contents.includes('SUMMARY_B'), contents.join(','))
  const asst = messages.find(
    m => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown[] }).tool_calls),
  )
  check('父一条消息里发了 2 个 Agent 调用', (asst as { tool_calls?: unknown[] })?.tool_calls?.length === 2)
  check('父最终输出 PARENT_DONE',
    [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content === 'PARENT_DONE')

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
