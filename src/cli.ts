#!/usr/bin/env -S npx tsx
// 入口：读配置 → 打印启动信息 → 启动 REPL。
import { loadConfig } from './config.js'
import { startRepl } from './repl.js'
import { initializeLspServerManager } from './services/lsp/manager.js'

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
