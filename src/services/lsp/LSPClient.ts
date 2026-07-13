// LSP 客户端，裁剪自参考项目 src/services/lsp/LSPClient.ts（448 行）。
// 保留（协议机制的核心）：spawn language server → 等 'spawn' 事件确认启动成功
//   （防 ENOENT 异步 error 导致的 unhandled rejection）→ vscode-jsonrpc 建连 →
//   initialize/initialized 握手 → sendRequest/sendNotification → 优雅 stop
//   （shutdown 请求 + exit 通知 + kill 进程）。onCrash 回调把崩溃状态回传上层。
// 简化：日志走 mini 的 lspDebug/lspLogError；env 用 process.env；去掉 Trace.Verbose
//      协议追踪（噪音大，mini 用 MCC_LSP_DEBUG 控制 stderr 输出即可）。
import { type ChildProcess, spawn } from 'child_process'
import {
  createMessageConnection,
  type MessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-jsonrpc/node.js'
import type {
  InitializeParams,
  InitializeResult,
  ServerCapabilities,
} from 'vscode-languageserver-protocol'
import { errorMessage, lspDebug, lspLogError } from './debug.js'

export type LSPClient = {
  readonly capabilities: ServerCapabilities | undefined
  readonly isInitialized: boolean
  start: (
    command: string,
    args: string[],
    options?: { env?: Record<string, string>; cwd?: string },
  ) => Promise<void>
  initialize: (params: InitializeParams) => Promise<InitializeResult>
  sendRequest: <TResult>(method: string, params: unknown) => Promise<TResult>
  sendNotification: (method: string, params: unknown) => Promise<void>
  onNotification: (method: string, handler: (params: unknown) => void) => void
  onRequest: <TParams, TResult>(
    method: string,
    handler: (params: TParams) => TResult | Promise<TResult>,
  ) => void
  stop: () => Promise<void>
}

/**
 * 创建一个基于 vscode-jsonrpc、通过 stdio 与 language server 进程通信的 LSP 客户端。
 * @param onCrash 进程在运行期意外退出（非主动 stop）时回调，供上层标记崩溃并按需重启。
 */
export function createLSPClient(
  serverName: string,
  onCrash?: (error: Error) => void,
): LSPClient {
  let proc: ChildProcess | undefined
  let connection: MessageConnection | undefined
  let capabilities: ServerCapabilities | undefined
  let isInitialized = false
  let startFailed = false
  let startError: Error | undefined
  let isStopping = false // 主动关闭标记，避免关闭过程中误报错误
  // 连接就绪前注册的 handler 先入队（lazy 初始化支持）
  const pendingHandlers: Array<{
    method: string
    handler: (params: unknown) => void
  }> = []
  const pendingRequestHandlers: Array<{
    method: string
    handler: (params: unknown) => unknown | Promise<unknown>
  }> = []

  function checkStartFailed(): void {
    if (startFailed) {
      throw startError || new Error(`LSP server ${serverName} failed to start`)
    }
  }

  return {
    get capabilities() {
      return capabilities
    },
    get isInitialized() {
      return isInitialized
    },

    async start(command, args, options): Promise<void> {
      try {
        // 1. spawn language server 进程
        proc = spawn(command, args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ...options?.env },
          cwd: options?.cwd,
          windowsHide: true,
        })

        if (!proc.stdout || !proc.stdin) {
          throw new Error('LSP server process stdio not available')
        }

        // 1.5 等 'spawn' 事件再用流：spawn() 立即返回，但 'error'（如命令不存在的
        // ENOENT）是异步触发的。不等确认就用流会在写入失败时产生 unhandled rejection。
        const spawned = proc
        await new Promise<void>((resolve, reject) => {
          const onSpawn = (): void => {
            cleanup()
            resolve()
          }
          const onError = (error: Error): void => {
            cleanup()
            reject(error)
          }
          const cleanup = (): void => {
            spawned.removeListener('spawn', onSpawn)
            spawned.removeListener('error', onError)
          }
          spawned.once('spawn', onSpawn)
          spawned.once('error', onError)
        })

        // 捕获 stderr 作为服务端诊断
        proc.stderr?.on('data', (data: Buffer) => {
          const output = data.toString().trim()
          if (output) lspDebug(`[server ${serverName}] ${output}`)
        })

        // 启动成功后的运行期错误（如崩溃）
        proc.on('error', error => {
          if (!isStopping) {
            startFailed = true
            startError = error
            lspLogError(
              new Error(`LSP server ${serverName} failed: ${error.message}`),
            )
          }
        })

        proc.on('exit', (code, _signal) => {
          if (code !== 0 && code !== null && !isStopping) {
            isInitialized = false
            startFailed = false
            startError = undefined
            const crashError = new Error(
              `LSP server ${serverName} crashed with exit code ${code}`,
            )
            lspLogError(crashError)
            onCrash?.(crashError)
          }
        })

        // stdin 流错误：进程先退出时防 unhandled rejection
        proc.stdin.on('error', (error: Error) => {
          if (!isStopping) {
            lspDebug(`LSP server ${serverName} stdin error: ${error.message}`)
          }
        })

        // 2. 建立 JSON-RPC 连接
        const reader = new StreamMessageReader(proc.stdout)
        const writer = new StreamMessageWriter(proc.stdin)
        connection = createMessageConnection(reader, writer)

        // 2.5 listen() 前注册 error/close，捕获崩溃/意外关闭，防 unhandled rejection
        connection.onError(([error]) => {
          if (!isStopping) {
            startFailed = true
            startError = error
            lspLogError(
              new Error(
                `LSP server ${serverName} connection error: ${error.message}`,
              ),
            )
          }
        })
        connection.onClose(() => {
          if (!isStopping) {
            isInitialized = false
            lspDebug(`LSP server ${serverName} connection closed`)
          }
        })

        // 3. 开始收消息
        connection.listen()

        // 4. 应用排队的 notification / request handler
        for (const { method, handler } of pendingHandlers) {
          connection.onNotification(method, handler)
        }
        pendingHandlers.length = 0
        for (const { method, handler } of pendingRequestHandlers) {
          connection.onRequest(method, handler)
        }
        pendingRequestHandlers.length = 0

        lspDebug(`LSP client started for ${serverName}`)
      } catch (error) {
        lspLogError(
          new Error(
            `LSP server ${serverName} failed to start: ${errorMessage(error)}`,
          ),
        )
        throw error
      }
    },

    async initialize(params): Promise<InitializeResult> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()
      try {
        const result: InitializeResult = await connection.sendRequest(
          'initialize',
          params,
        )
        capabilities = result.capabilities
        await connection.sendNotification('initialized', {})
        isInitialized = true
        lspDebug(`LSP server ${serverName} initialized`)
        return result
      } catch (error) {
        lspLogError(
          new Error(
            `LSP server ${serverName} initialize failed: ${errorMessage(error)}`,
          ),
        )
        throw error
      }
    },

    async sendRequest<TResult>(method: string, params: unknown): Promise<TResult> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()
      if (!isInitialized) throw new Error('LSP server not initialized')
      return connection.sendRequest(method, params)
    },

    async sendNotification(method: string, params: unknown): Promise<void> {
      if (!connection) throw new Error('LSP client not started')
      checkStartFailed()
      try {
        await connection.sendNotification(method, params)
      } catch (error) {
        // 通知是 fire-and-forget，失败不抛
        lspDebug(`Notification ${method} failed but continuing: ${errorMessage(error)}`)
      }
    },

    onNotification(method, handler): void {
      if (!connection) {
        pendingHandlers.push({ method, handler })
        return
      }
      checkStartFailed()
      connection.onNotification(method, handler)
    },

    onRequest(method, handler): void {
      if (!connection) {
        pendingRequestHandlers.push({
          method,
          handler: handler as (params: unknown) => unknown | Promise<unknown>,
        })
        return
      }
      checkStartFailed()
      connection.onRequest(method, handler)
    },

    async stop(): Promise<void> {
      let shutdownError: Error | undefined
      isStopping = true
      try {
        if (connection) {
          await connection.sendRequest('shutdown', {})
          await connection.sendNotification('exit', {})
        }
      } catch (error) {
        shutdownError = error as Error
      } finally {
        if (connection) {
          try {
            connection.dispose()
          } catch {
            /* 释放失败不致命 */
          }
          connection = undefined
        }
        if (proc) {
          proc.removeAllListeners('error')
          proc.removeAllListeners('exit')
          proc.stdin?.removeAllListeners('error')
          proc.stderr?.removeAllListeners('data')
          try {
            proc.kill()
          } catch {
            /* 可能已死，无所谓 */
          }
          proc = undefined
        }
        isInitialized = false
        capabilities = undefined
        isStopping = false
        if (shutdownError) {
          startFailed = true
          startError = shutdownError
        }
        lspDebug(`LSP client stopped for ${serverName}`)
      }
      if (shutdownError) throw shutdownError
    },
  }
}
