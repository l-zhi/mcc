#!/usr/bin/env -S npx tsx
// 用 mock 服务器离线、确定性地测「压缩效果」：
//   - compactMessages：把大历史总结成一条摘要 + 保留最近 N 条，断言重建结果与 token 下降
//   - 验证「只把旧消息发去总结、保留段不发」
//   - microcompact：清旧工具结果、token 下降
// 不烧 token。跑法：npx tsx test-compaction.ts
import { createServer } from 'http'
import type { ChatMessage } from '../src/api.js'
import type { Config } from '../src/config.js'
import { compactMessages, microcompactMessages } from '../src/compact.js'
import { estimateContextTokens } from '../src/context.js'

let pass = 0
let fail = 0
const check = (n: string, c: boolean, extra = ''): void => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; console.log(`  ✗ ${n} ${extra}`) }
}

const BIG = 'X'.repeat(20_000) // 放在要被总结掉的旧消息里，制造明显的 token 下降
const CANNED_SUMMARY =
  '<analysis>drafting</analysis>\n<summary>\n1. Primary Request and Intent: 用户在测试压缩\n2. Key Technical Concepts: compaction\n</summary>'

function makeConversation(): ChatMessage[] {
  return [
    { role: 'system', content: 'You are a coding assistant.' },
    { role: 'user', content: '分析项目结构' }, // ↓ 以下 4 条会被总结掉
    { role: 'assistant', content: null, tool_calls: [{ id: 'a1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls -R"}' } }] },
    { role: 'tool', tool_call_id: 'a1', content: BIG }, // 巨大工具结果
    { role: 'assistant', content: '分析完成。' },
    { role: 'user', content: '给 config 加 timeout' }, // ← 保留段从这里开始（user 边界）
    { role: 'assistant', content: null, tool_calls: [{ id: 'a2', type: 'function', function: { name: 'Edit', arguments: '{"file_path":"config.ts"}' } }] },
    { role: 'tool', tool_call_id: 'a2', content: 'edited config.ts' },
    { role: 'assistant', content: '已加上。' },
    { role: 'user', content: '再加单元测试' },
    { role: 'assistant', content: '好的。' },
  ]
}

async function main() {
  let captured: { messages: ChatMessage[] } | null = null
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => (raw += c))
    req.on('end', () => {
      captured = JSON.parse(raw)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: CANNED_SUMMARY } }], usage: { prompt_tokens: 500, completion_tokens: 50 } }))
    })
  })
  await new Promise<void>(r => server.listen(0, r))
  const port = (server.address() as { port: number }).port
  const config: Config = { apiKey: 'test', baseURL: `http://127.0.0.1:${port}`, model: 'mock', contextWindow: 128_000, maxTokens: 16_384 }

  console.log('\n[compactMessages：总结旧的 + 保留最近 N 条]')
  const messages = makeConversation()
  const beforeLen = messages.length
  const tokensBefore = estimateContextTokens(messages)
  const originalPivotMsg = messages[5]! // '给 config 加 timeout'

  const stats = await compactMessages(messages, config)
  server.close()

  check('返回压缩统计', stats !== null)
  check(`消息数下降（${beforeLen} → ${messages.length}）`, messages.length < beforeLen, `after=${messages.length}`)
  check('token 明显下降', estimateContextTokens(messages) < tokensBefore, `${tokensBefore} → ${estimateContextTokens(messages)}`)
  check('[0] 仍是 system', messages[0]!.role === 'system')
  check('[1] 是摘要 user 消息', messages[1]!.role === 'user' && /continued from an earlier conversation/.test(messages[1]!.content as string))
  check('摘要含模型返回的内容', /用户在测试压缩/.test(messages[1]!.content as string))
  check('保留段以原 user 边界开头', messages[2] === originalPivotMsg, `got: ${JSON.stringify(messages[2]).slice(0, 60)}`)
  check('最近的消息被保留', JSON.stringify(messages).includes('再加单元测试'))
  const stillHasBig = messages.some(m => typeof m.content === 'string' && m.content.includes(BIG))
  check('巨大旧工具结果已被总结掉（不在上下文里）', !stillHasBig)

  console.log('\n[只把旧消息发去总结、保留段不发]')
  const sentRoles = captured!.messages.map(m => m.role)
  check('总结请求 = [system, ...旧消息, 压缩指令(user)]', sentRoles[0] === 'system' && sentRoles[sentRoles.length - 1] === 'user')
  const sentJson = JSON.stringify(captured!.messages)
  check('旧的大工具结果被送去总结', sentJson.includes(BIG))
  check('保留段（再加单元测试）没有被送去总结', !sentJson.includes('再加单元测试'))

  console.log('\n[microcompact：清旧工具结果（保留最近 4 条，需 >4 条才清）]')
  // 构造 6 条工具结果，最早一条是巨大结果 → 应清理最早 2 条（含 BIG）、保留最近 4 条
  const conv: ChatMessage[] = [{ role: 'system', content: 's' }]
  for (let i = 0; i < 6; i++) {
    conv.push({ role: 'assistant', content: null, tool_calls: [{ id: `x${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] })
    conv.push({ role: 'tool', tool_call_id: `x${i}`, content: i === 0 ? BIG : `result-${i}` })
  }
  const convLen = conv.length
  const t0 = estimateContextTokens(conv)
  const freed = microcompactMessages(conv)
  const tools = conv.filter(m => m.role === 'tool') as { content: string }[]
  check('释放 token > 0', freed > 0, `freed=${freed}`)
  check('token 下降', estimateContextTokens(conv) < t0, `${t0} → ${estimateContextTokens(conv)}`)
  check('最早的大工具结果被清占位符', !conv.some(m => typeof m.content === 'string' && m.content.includes(BIG)))
  check('保留最近 4 条工具结果', tools.filter(m => /^result-/.test(m.content)).length === 4)
  check('清理了最早 2 条', tools.filter(m => m.content === '[旧工具结果已清理以节省上下文]').length === 2)
  check('消息骨架条数不变', conv.length === convLen)

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
