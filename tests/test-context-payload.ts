#!/usr/bin/env -S npx tsx
// 用本地 mock 服务器拦截 query 实际发给 LLM 的请求体，离线、确定性地验证
// 「上下文是怎么传给模型的」：system 提示词、消息顺序、工具、多轮累积、tool 配对。
// 顺带验证 trace 捕获（systemPrompt/toolNames/request）。不烧 token。
// 跑法：npx tsx test-context-payload.ts
import { createServer } from 'http'
import { readFileSync } from 'fs'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { getSystemPrompt } from '../src/prompts.js'
import { allTools, query } from '../src/query.js'
import { Tracer } from '../src/trace/Tracer.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}

type Body = { model: string; messages: ChatMessage[]; tools?: { function: { name: string } }[] }

async function main() {
  const captured: Body[] = []
  let call = 0

  // mock OpenAI 端点：第 1 次返回一个只读工具调用（Grep，免确认），第 2 次返回最终文本
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      captured.push(JSON.parse(raw))
      call++
      const message =
        call === 1
          ? { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'Grep', arguments: JSON.stringify({ pattern: 'import', path: '.' }) } }] }
          : { role: 'assistant', content: 'done' }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100 * call, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port

  const config: Config = { apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock-model', contextWindow: 128_000, maxTokens: 16_384 }
  const tracer = new Tracer(config)
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
    { role: 'user', content: 'hi' },
  ]
  tracer.startTurn('hi')
  const status = await query(messages, config, tracer)
  tracer.endTurn(status)
  server.close()

  console.log('\n[发给 LLM 的请求体（mock 拦截）]')
  check('共发起 2 次调用', captured.length === 2, `实际 ${captured.length}`)
  const c0 = captured[0]!, c1 = captured[1]!
  check('call#1 消息顺序 = [system,user]', JSON.stringify(c0.messages.map(m => m.role)) === '["system","user"]')
  check('model 正确传递', c0.model === 'mock-model')
  check('system 提示词随请求发出', typeof c0.messages[0]!.content === 'string' && (c0.messages[0]!.content as string).includes('mcc'))
  check('CLAUDE.md 记忆已进入上下文', (c0.messages[0]!.content as string).includes('# Memory'), '(若无则项目无 CLAUDE.md)')
  check(`工具 schema 随请求发出（${allTools.length} 个）`, c0.tools?.length === allTools.length)
  check('工具含 Grep/Bash', !!c0.tools?.some(t => t.function.name === 'Grep') && !!c0.tools?.some(t => t.function.name === 'Bash'))
  check('call#2 累积了上下文 [system,user,assistant,tool]', JSON.stringify(c1.messages.map(m => m.role)) === '["system","user","assistant","tool"]', JSON.stringify(c1.messages.map(m => m.role)))
  const asst = c1.messages[2] as { tool_calls?: { id: string }[] }
  const toolMsg = c1.messages[3] as { tool_call_id?: string }
  check('assistant 带 tool_calls', !!asst.tool_calls?.length)
  check('tool 消息与 tool_call id 配对', toolMsg.tool_call_id === 't1', `id=${toolMsg.tool_call_id}`)

  console.log('\n[trace 捕获（本次改动）]')
  const lines = readFileSync(process.env.HOME + '/.mcc/traces/trace.ndjson', 'utf8').trim().split('\n')
  const t = JSON.parse(lines[lines.length - 1]!)
  check('turn.systemPrompt 已存', typeof t.systemPrompt === 'string' && t.systemPrompt.includes('mcc'))
  check(`turn.toolNames 已存（${allTools.length}）`, Array.isArray(t.toolNames) && t.toolNames.length === allTools.length)
  check('记录了 2 个 step', t.steps.length === 2)
  check('step#1.request 累积到 assistant+tool', JSON.stringify((t.steps[1].request || []).map((m: { role: string }) => m.role)) === '["user","assistant","tool"]', JSON.stringify((t.steps[1].request || []).map((m: { role: string }) => m.role)))

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
