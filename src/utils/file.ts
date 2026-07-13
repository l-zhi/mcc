// 文件工具函数，copy/裁剪自参考项目 src/utils/file.ts 与 src/utils/readFileInRange.ts。
import { readdirSync, statSync } from 'fs'
import { readFile, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, dirname, extname, isAbsolute, join, resolve } from 'path'

export const FILE_NOT_FOUND_CWD_NOTE = 'Note: your current working directory is'

/** 单行超长截断阈值（参考实现对超长行的保护，防止单行 minified 文件炸上下文） */
export const MAX_LINE_LENGTH = 2000

/** ~ 展开 + 相对路径解析为绝对路径（参考 src/utils/path.ts expandPath 的简化版） */
export function expandPath(filePath: string): string {
  const trimmed = filePath.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/')) return join(homedir(), trimmed.slice(2))
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed)
}

/**
 * cat -n 风格行号，copy 自参考 addLineNumbers 的紧凑格式（`N\t`）。
 * 参考项目注释：带填充的 `     N→` 格式每行多 9 字节，占全量未缓存输入的 2.18%，
 * 已切换为紧凑格式。
 */
export function addLineNumbers({
  content,
  startLine, // 1-indexed
}: {
  content: string
  startLine: number
}): string {
  if (!content) {
    return ''
  }
  return content
    .split(/\r?\n/)
    .map((line, index) => `${index + startLine}\t${line}`)
    .join('\n')
}

/**
 * 同目录下找同名不同扩展名的文件，copy 自参考 findSimilarFile。
 * 用于文件不存在时给模型 "Did you mean xxx?" 建议。
 */
export function findSimilarFile(filePath: string): string | undefined {
  try {
    const dir = dirname(filePath)
    const fileBaseName = basename(filePath, extname(filePath))
    const files = readdirSync(dir)
    return files.find(
      file =>
        basename(file, extname(file)) === fileBaseName &&
        join(dir, file) !== filePath,
    )
  } catch {
    return undefined
  }
}

/** 绝对路径转 cwd 相对路径省 token（参考 utils/path.ts toRelativePath 的简化版），cwd 外的原样返回 */
export function toRelativePath(filePath: string): string {
  const cwd = process.cwd()
  if (filePath === cwd) return '.'
  if (filePath.startsWith(cwd + '/')) return filePath.slice(cwd.length + 1)
  return filePath
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export type ReadFileRangeResult = {
  content: string
  lineCount: number
  totalLines: number
  mtimeMs: number
}

/**
 * 读取文件的 [offset, offset + maxLines) 行区间，行为对齐参考 readFileInRange，
 * 实现走参考的 fast path（整读后按行切分）；streaming path（大文件/管道）未移植。
 * 超过 MAX_LINE_LENGTH 的行截断并标注。
 */
export async function readTextFileInRange(
  filePath: string,
  offset: number, // 0-indexed
  maxLines: number,
): Promise<ReadFileRangeResult> {
  const [raw, stats] = await Promise.all([
    readFile(filePath, 'utf-8'),
    stat(filePath),
  ])
  // 去 UTF-8 BOM，CRLF 归一为 LF（对齐参考实现）
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  // 空文件是 0 行，而不是 ''.split() 切出来的 1 个空行
  const allLines = text === '' ? [] : text.split(/\r?\n/)
  // 尾部换行符会切出一个多余空行，不计入总行数
  if (allLines.length > 1 && allLines[allLines.length - 1] === '') {
    allLines.pop()
  }

  const selected = allLines.slice(offset, offset + maxLines).map(line =>
    line.length > MAX_LINE_LENGTH
      ? line.slice(0, MAX_LINE_LENGTH) + '... (line truncated)'
      : line,
  )

  return {
    content: selected.join('\n'),
    lineCount: selected.length,
    totalLines: allLines.length,
    mtimeMs: stats.mtimeMs,
  }
}

export function getFileSizeSync(filePath: string): number {
  return statSync(filePath).size
}
