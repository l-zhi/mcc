// LSP 子系统的调试日志助手。参考项目用 logForDebugging（debug-gated）+ logError，
// mini 简化为：MCC_LSP_DEBUG 环境变量开启时打印 dim 调试日志；错误恒打印到 stderr。
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

export function lspDebug(message: string): void {
  if (process.env.MCC_LSP_DEBUG) {
    console.error(`${DIM}[lsp] ${message}${RESET}`)
  }
}

export function lspLogError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`${DIM}[lsp:error] ${message}${RESET}`)
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
