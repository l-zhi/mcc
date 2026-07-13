// LSP 结果格式化，裁剪自参考项目 src/tools/LSPTool/formatters.ts（592 行）。
// 保留：8 种操作的结果格式化（definition/references/hover/documentSymbol/
//   workspaceSymbol/callHierarchy 三种），URI→相对路径、0-based→1-based 行列转换、
//   按文件分组、SymbolKind 枚举转可读名、DocumentSymbol 层级缩进、无效 URI 过滤。
// 简化：logForDebugging→lspDebug；plural 用本地实现。
import { relative } from 'path'
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  DocumentSymbol,
  Hover,
  Location,
  LocationLink,
  MarkedString,
  MarkupContent,
  SymbolInformation,
  SymbolKind,
} from 'vscode-languageserver-types'
import { lspDebug } from '../../services/lsp/debug.js'

const plural = (n: number, word: string): string => (n === 1 ? word : `${word}s`)

/** URI → 相对路径（更短且不以 ../../ 开头时用相对），处理 file:// 与 Windows 盘符、解码失败兜底 */
function formatUri(uri: string | undefined, cwd?: string): string {
  if (!uri) {
    lspDebug('formatUri called with undefined URI - malformed LSP response')
    return '<unknown location>'
  }
  let filePath = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
  try {
    filePath = decodeURIComponent(filePath)
  } catch {
    /* 用未解码路径 */
  }
  if (cwd) {
    const relativePath = relative(cwd, filePath).replaceAll('\\', '/')
    if (relativePath.length < filePath.length && !relativePath.startsWith('../../')) {
      return relativePath
    }
  }
  return filePath.replaceAll('\\', '/')
}

function groupByFile<
  T extends { uri: string } | { location: { uri: string } },
>(items: T[], cwd?: string): Map<string, T[]> {
  const byFile = new Map<string, T[]>()
  for (const item of items) {
    const uri = 'uri' in item ? item.uri : item.location.uri
    const filePath = formatUri(uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(item)
    else byFile.set(filePath, [item])
  }
  return byFile
}

function formatLocation(location: Location, cwd?: string): string {
  const filePath = formatUri(location.uri, cwd)
  const line = location.range.start.line + 1 // 转 1-based
  const character = location.range.start.character + 1
  return `${filePath}:${line}:${character}`
}

function isLocationLink(item: Location | LocationLink): item is LocationLink {
  return 'targetUri' in item
}

function locationLinkToLocation(link: LocationLink): Location {
  return { uri: link.targetUri, range: link.targetSelectionRange || link.targetRange }
}

export function formatGoToDefinitionResult(
  result: Location | Location[] | LocationLink | LocationLink[] | null,
  cwd?: string,
): string {
  if (!result) {
    return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
  }
  if (Array.isArray(result)) {
    const locations: Location[] = result.map(item =>
      isLocationLink(item) ? locationLinkToLocation(item) : item,
    )
    const validLocations = locations.filter(loc => loc && loc.uri)
    if (validLocations.length === 0) {
      return 'No definition found. This may occur if the cursor is not on a symbol, or if the definition is in an external library not indexed by the LSP server.'
    }
    if (validLocations.length === 1) {
      return `Defined in ${formatLocation(validLocations[0]!, cwd)}`
    }
    const list = validLocations.map(loc => `  ${formatLocation(loc, cwd)}`).join('\n')
    return `Found ${validLocations.length} definitions:\n${list}`
  }
  const location = isLocationLink(result) ? locationLinkToLocation(result) : result
  return `Defined in ${formatLocation(location, cwd)}`
}

export function formatFindReferencesResult(
  result: Location[] | null,
  cwd?: string,
): string {
  const validLocations = (result || []).filter(loc => loc && loc.uri)
  if (validLocations.length === 0) {
    return 'No references found. This may occur if the symbol has no usages, or if the LSP server has not fully indexed the workspace.'
  }
  if (validLocations.length === 1) {
    return `Found 1 reference:\n  ${formatLocation(validLocations[0]!, cwd)}`
  }
  const byFile = groupByFile(validLocations, cwd)
  const lines: string[] = [
    `Found ${validLocations.length} references across ${byFile.size} files:`,
  ]
  for (const [filePath, locations] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const loc of locations) {
      lines.push(`  Line ${loc.range.start.line + 1}:${loc.range.start.character + 1}`)
    }
  }
  return lines.join('\n')
}

function extractMarkupText(
  contents: MarkupContent | MarkedString | MarkedString[],
): string {
  if (Array.isArray(contents)) {
    return contents
      .map(item => (typeof item === 'string' ? item : item.value))
      .join('\n\n')
  }
  if (typeof contents === 'string') return contents
  return contents.value // MarkupContent 或 MarkedString 对象
}

export function formatHoverResult(result: Hover | null, _cwd?: string): string {
  if (!result) {
    return 'No hover information available. This may occur if the cursor is not on a symbol, or if the LSP server has not fully indexed the file.'
  }
  const content = extractMarkupText(result.contents)
  if (result.range) {
    const line = result.range.start.line + 1
    const character = result.range.start.character + 1
    return `Hover info at ${line}:${character}:\n\n${content}`
  }
  return content
}

function symbolKindToString(kind: SymbolKind): string {
  const kinds: Record<number, string> = {
    1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
    6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
    11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant', 15: 'String',
    16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object', 20: 'Key',
    21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event', 25: 'Operator',
    26: 'TypeParameter',
  }
  return kinds[kind] || 'Unknown'
}

function formatDocumentSymbolNode(symbol: DocumentSymbol, indent = 0): string[] {
  const lines: string[] = []
  const prefix = '  '.repeat(indent)
  let line = `${prefix}${symbol.name} (${symbolKindToString(symbol.kind)})`
  if (symbol.detail) line += ` ${symbol.detail}`
  line += ` - Line ${symbol.range.start.line + 1}`
  lines.push(line)
  if (symbol.children && symbol.children.length > 0) {
    for (const child of symbol.children) {
      lines.push(...formatDocumentSymbolNode(child, indent + 1))
    }
  }
  return lines
}

export function formatDocumentSymbolResult(
  result: DocumentSymbol[] | SymbolInformation[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No symbols found in document. This may occur if the file is empty, not supported by the LSP server, or if the server has not fully indexed the file.'
  }
  // DocumentSymbol 有 range，SymbolInformation 有 location —— 据此判断格式
  const firstSymbol = result[0]
  const isSymbolInformation = firstSymbol && 'location' in firstSymbol
  if (isSymbolInformation) {
    return formatWorkspaceSymbolResult(result as SymbolInformation[], cwd)
  }
  const lines: string[] = ['Document symbols:']
  for (const symbol of result as DocumentSymbol[]) {
    lines.push(...formatDocumentSymbolNode(symbol))
  }
  return lines.join('\n')
}

export function formatWorkspaceSymbolResult(
  result: SymbolInformation[] | null,
  cwd?: string,
): string {
  const validSymbols = (result || []).filter(
    sym => sym && sym.location && sym.location.uri,
  )
  if (validSymbols.length === 0) {
    return 'No symbols found in workspace. This may occur if the workspace is empty, or if the LSP server has not finished indexing the project.'
  }
  const lines: string[] = [
    `Found ${validSymbols.length} ${plural(validSymbols.length, 'symbol')} in workspace:`,
  ]
  const byFile = groupByFile(validSymbols, cwd)
  for (const [filePath, symbols] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const symbol of symbols) {
      const kind = symbolKindToString(symbol.kind)
      let symbolLine = `  ${symbol.name} (${kind}) - Line ${symbol.location.range.start.line + 1}`
      if (symbol.containerName) symbolLine += ` in ${symbol.containerName}`
      lines.push(symbolLine)
    }
  }
  return lines.join('\n')
}

function formatCallHierarchyItem(item: CallHierarchyItem, cwd?: string): string {
  if (!item.uri) {
    return `${item.name} (${symbolKindToString(item.kind)}) - <unknown location>`
  }
  const filePath = formatUri(item.uri, cwd)
  let result = `${item.name} (${symbolKindToString(item.kind)}) - ${filePath}:${item.range.start.line + 1}`
  if (item.detail) result += ` [${item.detail}]`
  return result
}

export function formatPrepareCallHierarchyResult(
  result: CallHierarchyItem[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No call hierarchy item found at this position'
  }
  if (result.length === 1) {
    return `Call hierarchy item: ${formatCallHierarchyItem(result[0]!, cwd)}`
  }
  const lines = [`Found ${result.length} call hierarchy items:`]
  for (const item of result) lines.push(`  ${formatCallHierarchyItem(item, cwd)}`)
  return lines.join('\n')
}

export function formatIncomingCallsResult(
  result: CallHierarchyIncomingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No incoming calls found (nothing calls this function)'
  }
  const lines = [`Found ${result.length} incoming ${plural(result.length, 'call')}:`]
  const byFile = new Map<string, CallHierarchyIncomingCall[]>()
  for (const call of result) {
    if (!call.from) continue
    const filePath = formatUri(call.from.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(call)
    else byFile.set(filePath, [call])
  }
  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.from) continue
      const kind = symbolKindToString(call.from.kind)
      let callLine = `  ${call.from.name} (${kind}) - Line ${call.from.range.start.line + 1}`
      if (call.fromRanges && call.fromRanges.length > 0) {
        const sites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [calls at: ${sites}]`
      }
      lines.push(callLine)
    }
  }
  return lines.join('\n')
}

export function formatOutgoingCallsResult(
  result: CallHierarchyOutgoingCall[] | null,
  cwd?: string,
): string {
  if (!result || result.length === 0) {
    return 'No outgoing calls found (this function calls nothing)'
  }
  const lines = [`Found ${result.length} outgoing ${plural(result.length, 'call')}:`]
  const byFile = new Map<string, CallHierarchyOutgoingCall[]>()
  for (const call of result) {
    if (!call.to) continue
    const filePath = formatUri(call.to.uri, cwd)
    const existing = byFile.get(filePath)
    if (existing) existing.push(call)
    else byFile.set(filePath, [call])
  }
  for (const [filePath, calls] of byFile) {
    lines.push(`\n${filePath}:`)
    for (const call of calls) {
      if (!call.to) continue
      const kind = symbolKindToString(call.to.kind)
      let callLine = `  ${call.to.name} (${kind}) - Line ${call.to.range.start.line + 1}`
      if (call.fromRanges && call.fromRanges.length > 0) {
        const sites = call.fromRanges
          .map(r => `${r.start.line + 1}:${r.start.character + 1}`)
          .join(', ')
        callLine += ` [called from: ${sites}]`
      }
      lines.push(callLine)
    }
  }
  return lines.join('\n')
}
