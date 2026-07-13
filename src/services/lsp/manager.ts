// LSP 管理器单例，裁剪自参考项目 src/services/lsp/manager.ts（290 行）。
// 保留：单例 + 初始化状态机（not-started/pending/success/failed）、启动时非阻塞异步
//   初始化（initialize 只解析配置、创建实例，server 首次用到才 spawn，故很轻）、
//   waitForInitialization、isLspConnected（供工具判断是否有可用 server）、优雅 shutdown。
// 简化：去掉 generation 计数器（mini 只初始化一次，无重复 init 竞态）、去掉 bare 模式
//      与 plugin 重初始化、去掉 passive 诊断通知注册。
import {
  createLSPServerManager,
  type LSPServerManager,
} from './LSPServerManager.js'
import { errorMessage, lspDebug, lspLogError } from './debug.js'

type InitializationState = 'not-started' | 'pending' | 'success' | 'failed'

let instance: LSPServerManager | undefined
let state: InitializationState = 'not-started'
let initError: Error | undefined
let initPromise: Promise<void> | undefined

export function getLspServerManager(): LSPServerManager | undefined {
  if (state === 'failed') return undefined
  return instance
}

export function getInitializationStatus():
  | { status: 'not-started' }
  | { status: 'pending' }
  | { status: 'success' }
  | { status: 'failed'; error: Error } {
  if (state === 'failed') {
    return { status: 'failed', error: initError || new Error('Initialization failed') }
  }
  if (state === 'not-started') return { status: 'not-started' }
  if (state === 'pending') return { status: 'pending' }
  return { status: 'success' }
}

/** 是否至少有一个 language server 处于非 error 状态（供 LSP 工具判断可用性） */
export function isLspConnected(): boolean {
  if (state === 'failed') return false
  const manager = getLspServerManager()
  if (!manager) return false
  const servers = manager.getAllServers()
  if (servers.size === 0) return false
  for (const server of servers.values()) {
    if (server.state !== 'error') return true
  }
  return false
}

/** 等初始化完成；已完成/失败/未开始都立即返回 */
export async function waitForInitialization(): Promise<void> {
  if (state === 'success' || state === 'failed') return
  if (state === 'pending' && initPromise) await initPromise
}

/**
 * 初始化 LSP 管理器单例。启动时调用，同步创建实例、后台异步加载配置（不阻塞启动）。
 * 幂等：已初始化则跳过。
 */
export function initializeLspServerManager(): void {
  if (instance !== undefined && state !== 'failed') return

  instance = createLSPServerManager()
  state = 'pending'

  initPromise = instance
    .initialize()
    .then(() => {
      state = 'success'
      lspDebug('LSP server manager initialized successfully')
    })
    .catch((error: unknown) => {
      state = 'failed'
      initError = error as Error
      instance = undefined
      lspLogError(error)
      lspDebug(`Failed to initialize LSP server manager: ${errorMessage(error)}`)
    })
}

/** 关闭管理器并清理（进程退出时调用）。错误只记录不抛。 */
export async function shutdownLspServerManager(): Promise<void> {
  if (instance === undefined) return
  try {
    await instance.shutdown()
  } catch (error) {
    lspLogError(error)
  } finally {
    instance = undefined
    state = 'not-started'
    initError = undefined
    initPromise = undefined
  }
}
