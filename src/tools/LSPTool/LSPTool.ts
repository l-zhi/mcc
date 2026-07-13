// LSP 工具，裁剪自参考项目 src/tools/LSPTool/LSPTool.ts（861 行）。
// 保留（工具编排的核心）：operation→LSP method 映射（1-based→0-based 位置转换）、
//   等初始化完成、首次请求前 didOpen（含 10MB 上限）、incoming/outgoingCalls 的两步
//   （先 prepareCallHierarchy 拿 item 再请求 calls）、位置类结果的 gitignore 过滤
//   （git check-ignore 批量）、按 operation 分派 formatResult、优雅错误返回。
// 适配 mini Tool 接口：无 validateInput/checkPermissions/output schema，文件存在性检查
//   与结果都在 call 内完成，结果字符串直接作为 tool content 返回。
// 桩化：权限（query 层）。参考的 isEnabled(isLspConnected 门控) mini 无对应机制——
//   工具恒注册，无可用 server 时优雅返回「No LSP server available」，行为等价。
import { open } from 'fs/promises'
import { execFile } from 'child_process'
import { extname } from 'path'
import { pathToFileURL } from 'url'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  SymbolInformation,
} from 'vscode-languageserver-types'
import { z } from 'zod'
import {
  getInitializationStatus,
  getLspServerManager,
  waitForInitialization,
} from '../../services/lsp/manager.js'
import { buildTool, type ToolResult } from '../../Tool.js'
import { logEventStub } from '../../stubs.js'
import { expandPath } from '../../utils/file.js'
import {
  formatDocumentSymbolResult,
  formatFindReferencesResult,
  formatGoToDefinitionResult,
  formatHoverResult,
  formatIncomingCallsResult,
  formatOutgoingCallsResult,
  formatPrepareCallHierarchyResult,
  formatWorkspaceSymbolResult,
} from './formatters.js'
import { DESCRIPTION, LSP_TOOL_NAME } from './prompt.js'
import { lspToolInputSchema, OPERATIONS } from './schemas.js'

const MAX_LSP_FILE_SIZE_BYTES = 10_000_000

// tool 层用扁平 schema（九种操作字段相同），判别联合仅在 call 里用于更好的校验报错
const inputSchema = z.object({
  operation: z.enum(OPERATIONS).describe('The LSP operation to perform'),
  filePath: z.string().describe('The absolute or relative path to the file'),
  line: z
    .number()
    .int()
    .positive()
    .describe('The line number (1-based, as shown in editors)'),
  character: z
    .number()
    .int()
    .positive()
    .describe('The character offset (1-based, as shown in editors)'),
})
type Input = z.infer<typeof inputSchema>

export const LSPTool = buildTool({
  name: LSP_TOOL_NAME,
  description: DESCRIPTION,
  prompt: DESCRIPTION,
  inputSchema,
  isReadOnly() {
    return true
  },
  async call(input: Input): Promise<ToolResult> {
    // 判别联合校验（对齐参考 validateInput 的更好报错）
    const parsed = lspToolInputSchema.safeParse(input)
    if (!parsed.success) {
      return { content: `Invalid input: ${parsed.error.message}` }
    }

    const absolutePath = expandPath(input.filePath)
    const cwd = process.cwd()

    // 文件存在性检查（对齐参考 validateInput errorCode 1/2）
    try {
      const stats = await (await import('fs/promises')).stat(absolutePath)
      if (!stats.isFile()) {
        return { content: `Path is not a file: ${input.filePath}` }
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        return { content: `File does not exist: ${input.filePath}` }
      }
      throw e
    }

    // 初始化还在进行则等它，避免提前返回「无可用 server」
    if (getInitializationStatus().status === 'pending') {
      await waitForInitialization()
    }

    const manager = getLspServerManager()
    if (!manager) {
      return {
        content:
          'LSP server manager not initialized. This may indicate a startup issue.',
      }
    }

    const { method, params } = getMethodAndParams(input, absolutePath)

    try {
      // 请求前确保文件已在 server 里打开（多数 server 要求先 didOpen）
      if (!manager.isFileOpen(absolutePath)) {
        const handle = await open(absolutePath, 'r')
        try {
          const stats = await handle.stat()
          if (stats.size > MAX_LSP_FILE_SIZE_BYTES) {
            return {
              content: `File too large for LSP analysis (${Math.ceil(stats.size / 1_000_000)}MB exceeds 10MB limit)`,
            }
          }
          const fileContent = await handle.readFile({ encoding: 'utf-8' })
          await manager.openFile(absolutePath, fileContent)
        } finally {
          await handle.close()
        }
      }

      let result = await manager.sendRequest(absolutePath, method, params)

      if (result === undefined) {
        return {
          content: `No LSP server available for file type: ${extname(absolutePath)}`,
        }
      }

      // incoming/outgoingCalls 两步：先 prepareCallHierarchy 拿 item，再请求实际 calls
      if (input.operation === 'incomingCalls' || input.operation === 'outgoingCalls') {
        const callItems = result as CallHierarchyItem[]
        if (!callItems || callItems.length === 0) {
          return { content: 'No call hierarchy item found at this position' }
        }
        const callMethod =
          input.operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls'
        result = await manager.sendRequest(absolutePath, callMethod, {
          item: callItems[0],
        })
      }

      // 位置类结果过滤掉 gitignore 的文件
      if (
        result &&
        Array.isArray(result) &&
        (input.operation === 'findReferences' ||
          input.operation === 'goToDefinition' ||
          input.operation === 'goToImplementation' ||
          input.operation === 'workspaceSymbol')
      ) {
        if (input.operation === 'workspaceSymbol') {
          const symbols = result as SymbolInformation[]
          const locations = symbols.filter(s => s?.location?.uri).map(s => s.location)
          const filtered = await filterGitIgnoredLocations(locations, cwd)
          const keep = new Set(filtered.map(l => l.uri))
          result = symbols.filter(s => !s?.location?.uri || keep.has(s.location.uri))
        } else {
          const locations = (result as (Location | LocationLink)[]).map(toLocation)
          const filtered = await filterGitIgnoredLocations(locations, cwd)
          const keep = new Set(filtered.map(l => l.uri))
          result = (result as (Location | LocationLink)[]).filter(item => {
            const loc = toLocation(item)
            return !loc.uri || keep.has(loc.uri)
          })
        }
      }

      logEventStub('lsp_operation', { operation: input.operation })
      return { content: formatResult(input.operation, result, cwd) }
    } catch (error) {
      return {
        content: `Error performing ${input.operation}: ${(error as Error).message}`,
      }
    }
  },
})

/** operation → LSP method + params（1-based 转 0-based） */
function getMethodAndParams(
  input: Input,
  absolutePath: string,
): { method: string; params: unknown } {
  const uri = pathToFileURL(absolutePath).href
  const position = { line: input.line - 1, character: input.character - 1 }
  const textDocument = { uri }

  switch (input.operation) {
    case 'goToDefinition':
      return { method: 'textDocument/definition', params: { textDocument, position } }
    case 'findReferences':
      return {
        method: 'textDocument/references',
        params: { textDocument, position, context: { includeDeclaration: true } },
      }
    case 'hover':
      return { method: 'textDocument/hover', params: { textDocument, position } }
    case 'documentSymbol':
      return { method: 'textDocument/documentSymbol', params: { textDocument } }
    case 'workspaceSymbol':
      return { method: 'workspace/symbol', params: { query: '' } }
    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        params: { textDocument, position },
      }
    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      // 后两者先 prepareCallHierarchy 拿 item，再在 call 里发第二步请求
      return {
        method: 'textDocument/prepareCallHierarchy',
        params: { textDocument, position },
      }
  }
}

function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

function toLocation(item: Location | LocationLink): Location {
  if (isLocationLink(item)) {
    return { uri: item.targetUri, range: item.targetSelectionRange || item.targetRange }
  }
  return item
}

function uriToFilePath(uri: string): string {
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    /* 用未解码路径 */
  }
  return filePath
}

/** 用 git check-ignore 批量过滤掉被 gitignore 的位置（对齐参考，BATCH_SIZE=50） */
async function filterGitIgnoredLocations<T extends Location>(
  locations: T[],
  cwd: string,
): Promise<T[]> {
  if (locations.length === 0) return locations

  const uriToPath = new Map<string, string>()
  for (const loc of locations) {
    if (loc.uri && !uriToPath.has(loc.uri)) {
      uriToPath.set(loc.uri, uriToFilePath(loc.uri))
    }
  }
  const uniquePaths = [...new Set(uriToPath.values())]
  if (uniquePaths.length === 0) return locations

  const ignoredPaths = new Set<string>()
  const BATCH_SIZE = 50
  for (let i = 0; i < uniquePaths.length; i += BATCH_SIZE) {
    const batch = uniquePaths.slice(i, i + BATCH_SIZE)
    const stdout = await new Promise<string>(resolvePromise => {
      execFile(
        'git',
        ['check-ignore', ...batch],
        { cwd, timeout: 5_000 },
        (_error, out) => resolvePromise(out ?? ''), // exit 1（无忽略）也走这里，out 为空
      )
    })
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim()
      if (trimmed) ignoredPaths.add(trimmed)
    }
  }
  if (ignoredPaths.size === 0) return locations

  return locations.filter(loc => {
    const filePath = uriToPath.get(loc.uri)
    return !filePath || !ignoredPaths.has(filePath)
  })
}

/** 按 operation 分派到对应 formatter */
function formatResult(operation: Input['operation'], result: unknown, cwd: string): string {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return formatGoToDefinitionResult(
        result as Location | Location[] | LocationLink | LocationLink[] | null,
        cwd,
      )
    case 'findReferences':
      return formatFindReferencesResult(result as Location[] | null, cwd)
    case 'hover':
      return formatHoverResult(result as Hover | null, cwd)
    case 'documentSymbol':
      return formatDocumentSymbolResult(
        result as (DocumentSymbol[] | SymbolInformation[]) | null,
        cwd,
      )
    case 'workspaceSymbol':
      return formatWorkspaceSymbolResult(result as SymbolInformation[] | null, cwd)
    case 'prepareCallHierarchy':
      return formatPrepareCallHierarchyResult(result as CallHierarchyItem[] | null, cwd)
    case 'incomingCalls':
      return formatIncomingCallsResult(result as CallHierarchyIncomingCall[] | null, cwd)
    case 'outgoingCalls':
      return formatOutgoingCallsResult(result as CallHierarchyOutgoingCall[] | null, cwd)
  }
}
