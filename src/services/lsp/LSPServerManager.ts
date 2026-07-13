// LSP server 管理器，裁剪自参考项目 src/services/lsp/LSPServerManager.ts（421 行）。
// 保留（多 server 路由的核心）：从配置构建 扩展名→server 映射、按文件扩展名路由、
//   lazy 启动（首次用到才 spawn）、openFile 发 textDocument/didOpen（带 languageId +
//   已打开去重）、sendRequest 转发、workspace/configuration 反向请求返回 null（部分
//   server 如 typescript 即使我们声明不支持也会发）。
// 未移植：changeFile/saveFile/closeFile（参考用于 diagnostics/passive feedback，mini 无此子系统）。
import { extname, resolve } from 'path'
import { pathToFileURL } from 'url'
import { getAllLspServers } from './config.js'
import {
  createLSPServerInstance,
  type LSPServerInstance,
} from './LSPServerInstance.js'
import { errorMessage, lspDebug, lspLogError } from './debug.js'
import type { ScopedLspServerConfig } from './types.js'

export type LSPServerManager = {
  initialize(): Promise<void>
  shutdown(): Promise<void>
  ensureServerStarted(filePath: string): Promise<LSPServerInstance | undefined>
  sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined>
  getAllServers(): Map<string, LSPServerInstance>
  openFile(filePath: string, content: string): Promise<void>
  isFileOpen(filePath: string): boolean
}

export function createLSPServerManager(): LSPServerManager {
  const servers = new Map<string, LSPServerInstance>()
  const extensionMap = new Map<string, string[]>()
  // 记录哪个文件已在哪个 server 上打开（URI → serverName）
  const openedFiles = new Map<string, string>()

  async function initialize(): Promise<void> {
    const { servers: serverConfigs } = await getAllLspServers()

    for (const [serverName, config] of Object.entries(serverConfigs)) {
      try {
        if (!config.command) {
          throw new Error(`Server ${serverName} missing required 'command' field`)
        }
        if (
          !config.extensionToLanguage ||
          Object.keys(config.extensionToLanguage).length === 0
        ) {
          throw new Error(
            `Server ${serverName} missing required 'extensionToLanguage' field`,
          )
        }

        // 扩展名 → server 映射
        for (const ext of Object.keys(config.extensionToLanguage)) {
          const normalized = ext.toLowerCase()
          if (!extensionMap.has(normalized)) extensionMap.set(normalized, [])
          extensionMap.get(normalized)!.push(serverName)
        }

        const instance = createLSPServerInstance(serverName, config)
        servers.set(serverName, instance)

        // 部分 server（如 typescript）即使我们声明不支持也会发 workspace/configuration，
        // 给每个请求项返回 null 以满足协议
        instance.onRequest(
          'workspace/configuration',
          (params: { items: Array<{ section?: string }> }) =>
            params.items.map(() => null),
        )
      } catch (error) {
        lspLogError(
          new Error(
            `Failed to initialize LSP server ${serverName}: ${errorMessage(error)}`,
          ),
        )
        // 继续初始化其他 server，不因一个失败而整体失败
      }
    }
    lspDebug(`LSP manager initialized with ${servers.size} servers`)
  }

  async function shutdown(): Promise<void> {
    const toStop = Array.from(servers.values()).filter(
      s => s.state === 'running' || s.state === 'error',
    )
    await Promise.allSettled(toStop.map(s => s.stop()))
    servers.clear()
    extensionMap.clear()
    openedFiles.clear()
  }

  function getServerForFile(filePath: string): LSPServerInstance | undefined {
    const ext = extname(filePath).toLowerCase()
    const serverNames = extensionMap.get(ext)
    if (!serverNames || serverNames.length === 0) return undefined
    return servers.get(serverNames[0]!)
  }

  async function ensureServerStarted(
    filePath: string,
  ): Promise<LSPServerInstance | undefined> {
    const server = getServerForFile(filePath)
    if (!server) return undefined
    if (server.state === 'stopped' || server.state === 'error') {
      await server.start()
    }
    return server
  }

  async function sendRequest<T>(
    filePath: string,
    method: string,
    params: unknown,
  ): Promise<T | undefined> {
    const server = await ensureServerStarted(filePath)
    if (!server) return undefined
    return server.sendRequest<T>(method, params)
  }

  function getAllServers(): Map<string, LSPServerInstance> {
    return servers
  }

  async function openFile(filePath: string, content: string): Promise<void> {
    const server = await ensureServerStarted(filePath)
    if (!server) return

    const fileUri = pathToFileURL(resolve(filePath)).href
    if (openedFiles.get(fileUri) === server.name) return // 已打开，跳过

    const ext = extname(filePath).toLowerCase()
    const languageId = server.config.extensionToLanguage[ext] || 'plaintext'

    await server.sendNotification('textDocument/didOpen', {
      textDocument: { uri: fileUri, languageId, version: 1, text: content },
    })
    openedFiles.set(fileUri, server.name)
    lspDebug(`didOpen ${filePath} (languageId: ${languageId})`)
  }

  function isFileOpen(filePath: string): boolean {
    return openedFiles.has(pathToFileURL(resolve(filePath)).href)
  }

  return {
    initialize,
    shutdown,
    ensureServerStarted,
    sendRequest,
    getAllServers,
    openFile,
    isFileOpen,
  }
}
