#!/usr/bin/env -S npx tsx
// 记忆 + 上下文管理的纯逻辑回归测试（不经过 LLM）。
// 跑法：npx tsx test-memory-context.ts
// 注意：compactMessages（真实摘要）需要调模型，不在此测；见文末交互测试说明。
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage } from '../src/api.js'
import {
  formatCompactSummary,
  microcompactMessages,
} from '../src/compact.js'
import { decideCompaction, estimateContextTokens } from '../src/context.js'
import {
  appendProjectMemory,
  formatMemoriesForPrompt,
  loadMemories,
} from '../src/memory.js'

let pass = 0
let fail = 0
const check = (name: string, cond: boolean, extra = ''): void => {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

function testMemory(): void {
  console.log('\n[记忆管理]')
  const dir = mkdtempSync(join(tmpdir(), 'ccm-mem-'))
  process.chdir(dir)

  check('无记忆时注入为空', formatMemoriesForPrompt() === '')

  writeFileSync(join(dir, 'CLAUDE.md'), '# Project memory\n\n- 用 pnpm 不用 npm\n')
  const srcs = loadMemories()
  check('加载 project 记忆', srcs.length === 1 && srcs[0]!.label === 'Project')
  check('注入文本含内容', /用 pnpm 不用 npm/.test(formatMemoriesForPrompt()))

  const p = appendProjectMemory('提交前跑 typecheck')
  check('# 追加成功', /- 提交前跑 typecheck/.test(readFileSync(p, 'utf8')))

  const dir2 = mkdtempSync(join(tmpdir(), 'ccm-mem2-'))
  process.chdir(dir2)
  appendProjectMemory('第一条')
  const created = readFileSync(join(dir2, 'CLAUDE.md'), 'utf8')
  check('文件不存在时带标题创建', /# Project memory/.test(created) && /- 第一条/.test(created))
}

function testContext(): void {
  console.log('\n[上下文：估算 + 决策]')
  const W = 128_000
  const mkTool = (len: number): ChatMessage => ({
    role: 'tool',
    tool_call_id: 't',
    content: 'y'.repeat(len),
  })
  check('小对话 → none', decideCompaction([{ role: 'system', content: 's' }], W) === 'none')
  const micro: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    mkTool(4 * 90_000),
  ]
  check('~70% → microcompact', decideCompaction(micro, W) === 'microcompact', `est=${estimateContextTokens(micro)}`)
  const comp: ChatMessage[] = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    mkTool(4 * 115_000),
  ]
  check('~85%+ → compact', decideCompaction(comp, W) === 'compact', `est=${estimateContextTokens(comp)}`)

  console.log('\n[上下文：微压缩]')
  const conv: ChatMessage[] = [{ role: 'system', content: 's' }]
  for (let i = 0; i < 7; i++) {
    conv.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'Bash', arguments: '{}' } }] })
    conv.push({ role: 'tool', tool_call_id: `c${i}`, content: `RESULT-${i}-` + 'z'.repeat(500) })
  }
  const freed = microcompactMessages(conv)
  const tools = conv.filter(m => m.role === 'tool') as { content: string }[]
  check('清理释放 token > 0', freed > 0)
  check('保留最近 4 条', tools.filter(m => /^RESULT-/.test(m.content)).length === 4)
  check('清理其余 3 条', tools.filter(m => m.content === '[旧工具结果已清理以节省上下文]').length === 3)
  check('消息骨架不变', conv.filter(m => m.role === 'tool').length === 7)
  check('幂等（再清理释放 0）', microcompactMessages(conv) === 0)

  console.log('\n[上下文：摘要格式化]')
  const f = formatCompactSummary('<analysis>草稿</analysis>\n<summary>\n1. Intent: build X\n</summary>')
  check('剥离 analysis', !/草稿/.test(f))
  check('提取 summary', /Summary:/.test(f) && /Intent: build X/.test(f))
}

const originalCwd = process.cwd()
testMemory()
testContext()
process.chdir(originalCwd)
console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
