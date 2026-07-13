// 跑 tests/ 下所有 test-*.ts 并聚合结果。`npm test` / CI 的入口。
// 每个测试文件是独立 tsx 进程，用退出码判定通过与否。
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const dir = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(dir)
  .filter(f => /^test-.*\.ts$/.test(f))
  .sort()

let failed = 0
for (const f of files) {
  console.log(`\n──────── ${f} ────────`)
  try {
    execFileSync('npx', ['tsx', join(dir, f)], { stdio: 'inherit' })
  } catch {
    failed++
    console.error(`✗ ${f} 失败`)
  }
}

console.log(`\n════════ ${files.length - failed}/${files.length} 测试文件通过 ════════`)
process.exit(failed ? 1 : 0)
