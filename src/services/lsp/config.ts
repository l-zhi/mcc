// LSP server 配置来源，对应参考项目 src/services/lsp/config.ts。
// 关键差异：参考项目的 server 只能由 plugin 贡献（getAllLspServers 遍历已启用 plugin）。
// mini 没有 plugin 系统，改为内置一张 语言→server 配置表 作为等价来源，并允许用
// MCC_LSP_SERVERS 环境变量（JSON）追加/覆盖。server 二进制需用户自行安装（未装则
// 该文件类型的 LSP 操作优雅报「failed to start / no server available」，行为对齐参考）。
import { lspLogError } from './debug.js'
import type { ScopedLspServerConfig } from './types.js'

// 内置默认 server（命令需在 PATH 上；装法见 README）。
// 只列常见语言，够 mini 演示；要加语言直接改这里或用 MCC_LSP_SERVERS。
const BUILTIN_SERVERS: Record<string, ScopedLspServerConfig> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    },
  },
  pyright: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { '.py': 'python', '.pyi': 'python' },
  },
  gopls: {
    command: 'gopls',
    extensionToLanguage: { '.go': 'go' },
  },
  'rust-analyzer': {
    command: 'rust-analyzer',
    extensionToLanguage: { '.rs': 'rust' },
  },
}

/**
 * 返回所有配置的 LSP server。参考项目从 plugin 加载；mini 从内置表加载，
 * 并叠加 MCC_LSP_SERVERS（JSON，形如 {"名字": {command, args, extensionToLanguage}}）。
 */
export async function getAllLspServers(): Promise<{
  servers: Record<string, ScopedLspServerConfig>
}> {
  const servers: Record<string, ScopedLspServerConfig> = { ...BUILTIN_SERVERS }

  const override = process.env.MCC_LSP_SERVERS
  if (override) {
    try {
      Object.assign(
        servers,
        JSON.parse(override) as Record<string, ScopedLspServerConfig>,
      )
    } catch (error) {
      lspLogError(new Error(`MCC_LSP_SERVERS is not valid JSON: ${String(error)}`))
    }
  }

  return { servers }
}
