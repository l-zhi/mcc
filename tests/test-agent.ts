#!/usr/bin/env -S npx tsx
// Agent 工具（多 Agent Phase 1）的离线测试。用本地 mock 服务器拦截 query 发给 LLM 的请求，
// 确定性地验证：父代理派子代理 → 子代理用受限工具集独立跑 → 只把最后总结回传给父（上下文隔离）。
// 不烧 token。跑法：npx tsx tests/test-agent.ts
import { createServer } from 'http'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { getSystemPrompt } from '../src/prompts.js'
import { query } from '../src/query.js'
import { Tracer } from '../src/trace/Tracer.js'
import { DEFAULT_AGENT_TYPE, getAgentDefinition } from '../src/agents/registry.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}

const SUBAGENT_SUMMARY = 'SUBAGENT_SUMMARY: 主循环最多跑 20 轮，工具结果回填后继续。'

type Body = {
  messages: ChatMessage[]
  tools?: { function: { name: string } }[]
}

async function main() {
  const captured: Body[] = []

  // mock 端点：靠「本次请求的工具集里有没有 Agent」区分父/子。
  //   - 有 Agent 且还没委派 → 父第 1 次：返回一个 Agent 工具调用
  //   - 没有 Agent（= 子代理的受限工具集）→ 子代理：直接返回最终总结（无工具，子循环即结束）
  //   - 有 Agent 且已有 tool 结果 → 父第 2 次：返回最终文本
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      const body = JSON.parse(raw) as Body
      captured.push(body)
      const toolNames = (body.tools ?? []).map(t => t.function.name)
      const hasAgent = toolNames.includes('Agent')
      const alreadyDelegated = body.messages.some(m => m.role === 'tool')

      let message: Record<string, unknown>
      if (!hasAgent) {
        message = { role: 'assistant', content: SUBAGENT_SUMMARY }
      } else if (!alreadyDelegated) {
        message = {
          role: 'assistant', content: null,
          tool_calls: [{
            id: 'call_agent_1', type: 'function',
            function: {
              name: 'Agent',
              arguments: JSON.stringify({ description: '调研主循环', prompt: '读 src/query.ts 并用一句话总结主循环', subagent_type: 'explore' }),
            },
          }],
        }
      } else {
        message = { role: 'assistant', content: 'PARENT_DONE' }
      }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 10 } }))
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port

  const config: Config = {
    apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock',
    contextWindow: 128_000, maxTokens: 16_384,
  }
  const tracer = new Tracer(config, { disabled: true })
  const messages: ChatMessage[] = [
    { role: 'system', content: getSystemPrompt(config.model) },
    { role: 'user', content: '派子代理调研主循环' },
  ]
  const status = await query(messages, config, tracer, {})
  server.close()

  console.log('\n[父/子调用编排]')
  check('共 3 次 LLM 调用（父·子·父）', captured.length === 3, `实际 ${captured.length}`)
  check('本轮收尾 ok', status === 'ok', status)

  // 恰好一次子代理调用（工具集里没有 Agent 的那次）
  const subCalls = captured.filter(b => !(b.tools ?? []).some(t => t.function.name === 'Agent'))
  check('恰好一次子代理调用', subCalls.length === 1, `实际 ${subCalls.length}`)

  console.log('\n[Phase 2：类型注册表]')
  check('DEFAULT_AGENT_TYPE = general-purpose', DEFAULT_AGENT_TYPE === 'general-purpose')
  check('explore 类型存在', !!getAgentDefinition('explore'))
  check('未知类型返回 undefined', getAgentDefinition('nope') === undefined)

  console.log('\n[递归护栏 + explore 类型工具集]')
  const sub = subCalls[0]!
  const subToolNames = (sub.tools ?? []).map(t => t.function.name)
  check('子代理工具集不含 Agent（防递归）', !subToolNames.includes('Agent'))
  check('子代理工具集不含 TodoWrite（不覆盖共享待办）', !subToolNames.includes('TodoWrite'))
  check('explore 含只读工具 Read/Grep/Glob/LSP',
    ['Read', 'Grep', 'Glob', 'LSP'].every(n => subToolNames.includes(n)))
  check('explore 不含 Write/Edit/Bash/NotebookEdit',
    !['Write', 'Edit', 'Bash', 'NotebookEdit'].some(n => subToolNames.includes(n)),
    subToolNames.join(','))

  console.log('\n[子代理系统提示词]')
  const subSystem = sub.messages[0]
  check('子代理带独立 system', subSystem?.role === 'system')
  check('system 含「Subagent mode」标记', String(subSystem?.content).includes('Subagent mode'))
  check('子代理首条 user = 父给的 prompt', sub.messages[1]?.role === 'user' && String(sub.messages[1]?.content).includes('总结主循环'))

  console.log('\n[上下文隔离：父只拿到总结]')
  const toolMsg = messages.find(m => m.role === 'tool')
  check('父上下文里有 Agent 的 tool 结果', !!toolMsg)
  check('tool 结果 = 子代理最终总结', String(toolMsg?.content).trim() === SUBAGENT_SUMMARY)
  // 子代理跑了多少条内部消息，父都不应看到——父消息数很小：system,user,assistant(toolcall),tool,assistant(done)
  check('子代理内部消息未泄漏进父上下文', messages.length === 5, `父消息数 ${messages.length}`)
  const lastText = [...messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content)?.content
  check('父最终输出 PARENT_DONE', lastText === 'PARENT_DONE')

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
