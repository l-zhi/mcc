// Read 工具，裁剪自参考项目 src/tools/FileReadTool/FileReadTool.ts（1183 行）。
// 保留：文本（offset/limit/行号/超长行截断/空文件提醒）、图片、PDF（pdftoppm）、
//      notebook 四条路径，文件不存在时的相似文件名建议，设备文件拦截。
// 桩化：权限 / 读缓存 / 埋点 / skills 发现（见 stubs.ts）。
// 未移植：token 预算校验（需要 API countTokens）、macOS 截图路径空格兜底、
//        UNC 路径安全检查、文件读取监听器。
import { statSync } from 'fs'
import * as path from 'path'
import { z } from 'zod'
import type { ChatMessage, ContentPart } from '../../api.js'
import { readFileState } from '../../readFileState.js'
import { buildTool, type ToolResult } from '../../Tool.js'
import { discoverSkillsStub, logEventStub, readFileStateStub } from '../../stubs.js'
import {
  addLineNumbers,
  expandPath,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  formatFileSize,
  readTextFileInRange,
} from '../../utils/file.js'
import { IMAGE_EXTENSIONS, readImage } from './imageReader.js'
import { readNotebook } from './notebookReader.js'
import {
  extractPDFPages,
  getPDFPageCount,
  parsePDFPageRange,
} from './pdfReader.js'
import {
  DESCRIPTION,
  FILE_READ_TOOL_NAME,
  MAX_LINES_TO_READ,
  PDF_INLINE_PAGE_THRESHOLD,
  PDF_MAX_PAGES_PER_READ,
  PROMPT,
} from './prompt.js'

/** 文本读取的总文件大小上限（对齐参考 maxSizeBytes 默认 256KB，超限时提示用 offset/limit） */
const MAX_SIZE_BYTES = 256 * 1024

// 会挂死进程的设备文件：无限输出或阻塞等待输入（copy 自参考 BLOCKED_DEVICE_PATHS）
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/full',
  '/dev/stdin',
  '/dev/tty',
  '/dev/console',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/fd/0',
  '/dev/fd/1',
  '/dev/fd/2',
])

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  if (
    filePath.startsWith('/proc/') &&
    (filePath.endsWith('/fd/0') ||
      filePath.endsWith('/fd/1') ||
      filePath.endsWith('/fd/2'))
  )
    return true
  return false
}

const inputSchema = z.object({
  file_path: z.string().describe('The absolute path to the file to read'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(
      'The line number to start reading from. Only provide if the file is too large to read at once',
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The number of lines to read. Only provide if the file is too large to read at once.',
    ),
  pages: z
    .string()
    .optional()
    .describe(
      `Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
    ),
})

function imagePartsToUserMessage(dataUrls: string[]): ChatMessage {
  const parts: ContentPart[] = dataUrls.map(url => ({
    type: 'image_url' as const,
    image_url: { url },
  }))
  return { role: 'user', content: parts }
}

async function callInner(
  file_path: string,
  fullFilePath: string,
  ext: string,
  offset: number,
  limit: number | undefined,
  pages: string | undefined,
): Promise<ToolResult> {
  // --- Notebook ---
  if (ext === 'ipynb') {
    const { text, images } = await readNotebook(fullFilePath)
    // 登记读状态，Write 的先读后写校验依赖它（对齐参考实现）
    readFileState.set(fullFilePath, {
      content: text,
      timestamp: Math.floor(statSync(fullFilePath).mtimeMs),
      offset,
      limit,
      isPartialView: false,
    })
    logEventStub('file_read', { ext, type: 'notebook' })
    return {
      content: text,
      ...(images.length > 0 && {
        newMessages: [imagePartsToUserMessage(images)],
      }),
    }
  }

  // --- 图片 ---
  if (IMAGE_EXTENSIONS.has(ext)) {
    const image = await readImage(fullFilePath, ext)
    logEventStub('file_read', { ext, type: 'image' })
    return {
      // OpenAI 协议 tool 消息只能是文本，图片作为 user 消息注入（对齐参考 newMessages 机制）
      content: `Read image: ${file_path} (${formatFileSize(image.originalSize)}). The image is attached to the conversation as the next user message.`,
      newMessages: [imagePartsToUserMessage([image.dataUrl])],
    }
  }

  // --- PDF：统一走 pdftoppm 渲染成 JPEG 注入 ---
  if (ext === 'pdf') {
    let range: { firstPage: number; lastPage: number } | undefined
    if (pages) {
      range = parsePDFPageRange(pages) ?? undefined
      // pages 格式在 call() 入口已校验过，这里必然有值
    } else {
      const pageCount = await getPDFPageCount(fullFilePath)
      if (pageCount !== null && pageCount > PDF_INLINE_PAGE_THRESHOLD) {
        throw new Error(
          `This PDF has ${pageCount} pages, which is too many to read at once. ` +
            `Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). ` +
            `Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
        )
      }
    }

    const result = await extractPDFPages(fullFilePath, range)
    logEventStub('pdf_page_extraction', {
      pageCount: result.pageBuffers.length,
      fileSize: result.originalSize,
      hasPageRange: pages !== undefined,
    })
    const dataUrls = result.pageBuffers.map(
      buf => `data:image/jpeg;base64,${buf.toString('base64')}`,
    )
    return {
      content: `PDF pages extracted: ${result.pageBuffers.length} page(s) from ${file_path} (${formatFileSize(result.originalSize)}). The pages are attached to the conversation as images in the next user message.`,
      newMessages: [imagePartsToUserMessage(dataUrls)],
    }
  }

  // --- 文本文件 ---
  // 总文件大小护栏（对齐参考 maxSizeBytes：按整个文件而不是切片计算，超限即抛错）
  const stats = statSync(fullFilePath)
  if (stats.size > MAX_SIZE_BYTES && offset === 1 && limit === undefined) {
    throw new Error(
      `File content (${formatFileSize(stats.size)}) exceeds maximum allowed size (${formatFileSize(MAX_SIZE_BYTES)}). Use offset and limit parameters to read specific portions of the file, or search for specific content instead of reading the whole file.`,
    )
  }

  const lineOffset = offset === 0 ? 0 : offset - 1
  const { content, lineCount, totalLines, mtimeMs } = await readTextFileInRange(
    fullFilePath,
    lineOffset,
    limit ?? MAX_LINES_TO_READ,
  )

  // 登记读状态，Write 的先读后写校验依赖它（对齐参考实现）。
  // 没读全（offset 跳过了开头，或者尾部被 limit/2000 行上限截掉）算部分视图，
  // 部分视图不允许作为整文件覆写的依据。
  readFileState.set(fullFilePath, {
    content,
    timestamp: Math.floor(mtimeMs),
    offset,
    limit,
    isPartialView: lineOffset > 0 || lineOffset + lineCount < totalLines,
  })

  logEventStub('file_read', {
    ext,
    type: 'text',
    totalLines,
    readLines: lineCount,
  })

  if (!content) {
    // 对齐参考实现：空文件/offset 超出文件末尾时返回 system-reminder
    return {
      content:
        totalLines === 0
          ? '<system-reminder>Warning: the file exists but the contents are empty.</system-reminder>'
          : `<system-reminder>Warning: the file exists but is shorter than the provided offset (${offset}). The file has ${totalLines} lines.</system-reminder>`,
    }
  }

  return { content: addLineNumbers({ content, startLine: offset }) }
}

export const FileReadTool = buildTool({
  name: FILE_READ_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return true
  },
  async call({ file_path, offset = 1, limit, pages }) {
    // --- 输入校验（对齐参考 validateInput，纯字符串检查、无 I/O） ---
    if (pages !== undefined) {
      const parsed = parsePDFPageRange(pages)
      if (!parsed) {
        throw new Error(
          `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
        )
      }
      const rangeSize =
        parsed.lastPage === Infinity
          ? PDF_MAX_PAGES_PER_READ + 1
          : parsed.lastPage - parsed.firstPage + 1
      if (rangeSize > PDF_MAX_PAGES_PER_READ) {
        throw new Error(
          `Page range "${pages}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
        )
      }
    }

    const fullFilePath = expandPath(file_path)

    if (isBlockedDevicePath(fullFilePath)) {
      throw new Error(
        `Cannot read '${file_path}': this device file would block or produce infinite output.`,
      )
    }

    // 框架挂点（真实现见参考项目，这里是日志桩）
    readFileStateStub(fullFilePath)
    discoverSkillsStub(fullFilePath)

    const ext = path.extname(fullFilePath).toLowerCase().slice(1)
    try {
      return await callInner(file_path, fullFilePath, ext, offset, limit, pages)
    } catch (error) {
      // 文件不存在：给相似文件名建议（对齐参考 ENOENT 处理）
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const similarFilename = findSimilarFile(fullFilePath)
        let message = `File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`
        if (similarFilename) {
          message += ` Did you mean ${similarFilename}?`
        }
        throw new Error(message)
      }
      throw error
    }
  },
})
