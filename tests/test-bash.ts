#!/usr/bin/env -S npx tsx
// Bash 工具冒烟测试：直接调 execBash / BashTool.call，不经过 LLM。
// 跑法：npx tsx test-bash.ts
import { execBash } from '../src/utils/shell.js'
import { BashTool } from '../src/tools/BashTool/BashTool.js'
import { checkDangerousCommand } from '../src/tools/BashTool/dangerousCommands.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

async function main() {
  console.log('\n[执行核心 execBash]')
  let r = await execBash('echo hello')
  check('stdout 捕获', r.stdout.trim() === 'hello' && r.code === 0)

  r = await execBash('ls /nonexistent_xyz')
  check('非零退出码 + stderr', r.code !== 0 && r.stderr.length > 0)

  r = await execBash('echo "a\nb\nc" | grep b')
  check('管道', r.stdout.trim() === 'b')

  const origin = process.cwd()
  await execBash('cd /tmp')
  r = await execBash('pwd')
  check('cwd 跨命令持久化', r.stdout.trim() === '/private/tmp' || r.stdout.trim() === '/tmp',
    `实际: ${r.stdout.trim()}`)
  process.chdir(origin)

  const t0 = Date.now()
  r = await execBash('sleep 5', { timeout: 800 })
  check('超时击杀（<2s 返回）', r.interrupted && Date.now() - t0 < 2000)

  console.log('\n[危险命令拦截 checkDangerousCommand]')
  for (const cmd of ['rm -rf /', 'rm -fr ~', ':(){ :|:& };:', 'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda']) {
    check(`拦截: ${cmd}`, checkDangerousCommand(cmd) !== null)
  }
  for (const cmd of ['rm -rf node_modules', 'git reset --hard', 'dd if=a.img of=b.img']) {
    check(`放行: ${cmd}`, checkDangerousCommand(cmd) === null)
  }

  console.log('\n[工具层 BashTool.call]')
  const ok = await BashTool.call({ command: 'echo tool-ok' })
  check('正常命令通过', ok.content === 'tool-ok')

  try {
    await BashTool.call({ command: 'rm -rf /' })
    check('危险命令被拒绝（应抛错）', false)
  } catch {
    check('危险命令被拒绝（抛错）', true)
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
  process.exit(fail === 0 ? 0 : 1)
}
main()
