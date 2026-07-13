// 单个 LSP server 实例，裁剪自参考项目 src/services/lsp/LSPServerInstance.ts（512 行）。
// 保留（生命周期与协议的核心）：状态机（stopped→starting→running→stopping / →error）、
//   initialize 参数（workspaceFolders + rootUri + 客户端 capabilities，含 typescript
//   靠 rootUri 定位 definition 等关键点）、content-modified(-32801) 瞬时错误指数退避重试、
//   崩溃恢复次数上限、健康检查。
// 简化：日志走 mini helper；去掉未实现字段（restartOnCrash/shutdownTimeout）的显式报错；
//      LSPClient 用静态 import（参考用 lazy require 省 vscode-jsonrpc 体积，mini 不介意）。
import { basename } from 'path'
import { pathToFileURL } from 'url'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import { createLSPClient } from './LSPClient.js'
import { errorMessage, lspDebug, lspLogError } from './debug.js'
import type { LspServerState, ScopedLspServerConfig } from './types.js'

// server 处理请求期间状态变化（如 rust-analyzer 仍在索引）→ 可重试的瞬时错误
const LSP_ERROR_CONTENT_MODIFIED = -32801
const MAX_RETRIES_FOR_TRANSIENT_ERRORS = 3
const RETRY_BASE_DELAY_MS = 500 // 实际退避 500 / 1000 / 2000ms

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

export type LSPServerInstance = {
  readonly name: string
  readonly config: ScopedLspServerConfig
  readonly state: LspServerState
  readonly lastError: Error | undefined
  start(): Promise<void>
  stop(): Promise<void>
  isHealthy(): boolean
  sendRequest<T>(method: string, params: unknown): Promise<T>
  sendNotification(method: string, params: unknown): Promise<void>
  onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void
}

export function createLSPServerInstance(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  let state: LspServerState = 'stopped'
  let lastError: Error | undefined
  let crashRecoveryCount = 0
  // 把崩溃状态回传，使 ensureServerStarted 下次使用时能重启（否则卡在 running 僵尸态）
  const client = createLSPClient(name, error => {
    state = 'error'
    lastError = error
    crashRecoveryCount++
  })

  async function start(): Promise<void> {
    if (state === 'running' || state === 'starting') return

    // 崩溃恢复次数封顶，防止持续崩溃的 server 每次请求都 spawn 新进程
    const maxRestarts = config.maxRestarts ?? 3
    if (state === 'error' && crashRecoveryCount > maxRestarts) {
      const error = new Error(
        `LSP server '${name}' exceeded max crash recovery attempts (${maxRestarts})`,
      )
      lastError = error
      throw error
    }

    let initPromise: Promise<unknown> | undefined
    try {
      state = 'starting'
      await client.start(config.command, config.args || [], {
        env: config.env,
        cwd: config.workspaceFolder,
      })

      const workspaceFolder = config.workspaceFolder || process.cwd()
      const workspaceUri = pathToFileURL(workspaceFolder).href

      const initParams: InitializeParams = {
        processId: process.pid,
        initializationOptions: config.initializationOptions ?? {},
        // LSP 3.16+ 现代方式，Pyright/gopls 需要
        workspaceFolders: [
          { uri: workspaceUri, name: basename(workspaceFolder) },
        ],
        // 已废弃但部分 server 仍需要：typescript-language-server 的 goToDefinition 靠 rootUri
        rootPath: workspaceFolder,
        rootUri: workspaceUri,
        capabilities: {
          workspace: {
            // 不声明支持 workspace/configuration（我们没实现），免得 server 来要
            configuration: false,
            workspaceFolders: false,
          },
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: true,
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['markdown', 'plaintext'],
            },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            documentSymbol: {
              dynamicRegistration: false,
              hierarchicalDocumentSymbolSupport: true,
            },
            callHierarchy: { dynamicRegistration: false },
          },
          general: { positionEncodings: ['utf-16'] },
        },
      }

      initPromise = client.initialize(initParams)
      if (config.startupTimeout !== undefined) {
        await withTimeout(
          initPromise,
          config.startupTimeout,
          `LSP server '${name}' timed out after ${config.startupTimeout}ms during initialization`,
        )
      } else {
        await initPromise
      }

      state = 'running'
      crashRecoveryCount = 0
      lspDebug(`LSP server instance started: ${name}`)
    } catch (error) {
      client.stop().catch(() => {})
      initPromise?.catch(() => {})
      state = 'error'
      lastError = error as Error
      lspLogError(error)
      throw error
    }
  }

  async function stop(): Promise<void> {
    if (state === 'stopped' || state === 'stopping') return
    try {
      state = 'stopping'
      await client.stop()
      state = 'stopped'
    } catch (error) {
      state = 'error'
      lastError = error as Error
      throw error
    }
  }

  function isHealthy(): boolean {
    return state === 'running' && client.isInitialized
  }

  async function sendRequest<T>(method: string, params: unknown): Promise<T> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send request to LSP server '${name}': server is ${state}` +
          `${lastError ? `, last error: ${lastError.message}` : ''}`,
      )
    }

    let lastAttemptError: Error | undefined
    for (let attempt = 0; attempt <= MAX_RETRIES_FOR_TRANSIENT_ERRORS; attempt++) {
      try {
        return await client.sendRequest(method, params)
      } catch (error) {
        lastAttemptError = error as Error
        // content-modified 常见于 server 仍在索引，按 LSP 规范应静默重试。
        // 用鸭子类型判断 code（依赖树里可能有多版本 vscode-jsonrpc）。
        const errorCode = (error as { code?: number }).code
        const isContentModified =
          typeof errorCode === 'number' && errorCode === LSP_ERROR_CONTENT_MODIFIED
        if (isContentModified && attempt < MAX_RETRIES_FOR_TRANSIENT_ERRORS) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          lspDebug(
            `LSP request '${method}' to '${name}' got ContentModified, retrying in ${delay}ms`,
          )
          await sleep(delay)
          continue
        }
        break
      }
    }
    throw new Error(
      `LSP request '${method}' failed for server '${name}': ${lastAttemptError?.message ?? 'unknown error'}`,
    )
  }

  async function sendNotification(method: string, params: unknown): Promise<void> {
    if (!isHealthy()) {
      throw new Error(
        `Cannot send notification to LSP server '${name}': server is ${state}`,
      )
    }
    try {
      await client.sendNotification(method, params)
    } catch (error) {
      throw new Error(
        `LSP notification '${method}' failed for server '${name}': ${errorMessage(error)}`,
      )
    }
  }

  function onRequest<TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ): void {
    client.onRequest(method, handler)
  }

  return {
    name,
    config,
    get state() {
      return state
    },
    get lastError() {
      return lastError
    },
    start,
    stop,
    isHealthy,
    sendRequest,
    sendNotification,
    onRequest,
  }
}

/** promise 与超时竞速，无论结果都清理定时器，避免孤儿 setTimeout 的 unhandled rejection */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer!))
}
