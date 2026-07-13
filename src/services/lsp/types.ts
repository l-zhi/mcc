// LSP 服务层类型，对齐参考项目 src/services/lsp/types.ts。
// 参考项目的 server 配置来自 plugin；mini 没有 plugin 系统，改为内置配置表
// （见 config.ts），因此这里的 ScopedLspServerConfig 只保留 mini 实际用到的字段。

export type LspServerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'error'

export type ScopedLspServerConfig = {
  /** 启动 language server 的命令（如 'typescript-language-server'） */
  command: string
  /** 命令参数（如 ['--stdio']） */
  args?: string[]
  /** 扩展名 → LSP languageId（如 { '.ts': 'typescript' }），也用于扩展名路由 */
  extensionToLanguage: Record<string, string>
  /** 额外环境变量 */
  env?: Record<string, string>
  /** workspace 根目录，缺省用 cwd */
  workspaceFolder?: string
  /** initialize 请求的 initializationOptions */
  initializationOptions?: Record<string, unknown>
  /** 启动超时（ms） */
  startupTimeout?: number
  /** 最大崩溃重启次数，缺省 3 */
  maxRestarts?: number
}
