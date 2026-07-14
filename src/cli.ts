#!/usr/bin/env -S npx tsx
// 入口：解析 -d 指定工作目录 → 读配置 → 打印启动信息 → 启动 REPL。
import { existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { loadConfig } from './config.js'
import { startRepl } from './repl.js'
import { initializeLspServerManager } from './services/lsp/manager.js'
import { expandPath } from './utils/file.js'

// -d / --dir <path>：在指定代码库里启动（不传则用当前目录）。
// 全项目的工作目录都走 process.cwd()，所以只需在读 cwd 的任何代码之前 chdir 一次，
// 整条链路（系统提示词 / 记忆 / 工具 / trace）就都以该目录为准。
function parseDirArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-d' || a === '--dir') return argv[i + 1]
    if (a.startsWith('--dir=')) return a.slice('--dir='.length)
  }
  return undefined
}

const dir = parseDirArg(process.argv.slice(2))
if (dir !== undefined) {
  if (!dir) {
    console.error('用法：mcc -d <目录>（-d 后需跟目录路径）')
    process.exit(1)
  }
  const target = resolve(expandPath(dir))
  if (!existsSync(target) || !statSync(target).isDirectory()) {
    console.error(`目录不存在或不是文件夹：${dir}`)
    process.exit(1)
  }
  process.chdir(target) // 必须在任何依赖 cwd 的代码之前
}

const config = loadConfig()

console.log(`mcc`)
console.log(`  model:   ${config.model}`)
console.log(`  baseURL: ${config.baseURL}`)
console.log(`  cwd:     ${process.cwd()}`)
console.log(`输入 exit / quit 或 Ctrl+C 退出\n`)

// 后台异步初始化 LSP（只解析配置/建实例，server 首次用到才 spawn，不阻塞启动）。
// 对齐参考项目启动时调用 initializeLspServerManager()。
initializeLspServerManager()

await startRepl(config)
