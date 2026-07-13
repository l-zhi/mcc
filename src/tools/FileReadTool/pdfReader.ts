// PDF 读取：用 pdftoppm（poppler-utils）把页面渲染成 JPEG，复用图片注入管线。
// copy/裁剪自参考项目 src/utils/pdf.ts 的 extractPDFPages / getPDFPageCount /
// isPdftoppmAvailable，以及 src/utils/pdfUtils.ts 的 parsePDFPageRange。
// 有些实现对 ≤3MB 小 PDF 走原生 document 块、由 API 服务端解析，
// OpenAI 协议无此能力，本项目所有 PDF 统一走本渲染路径。
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { formatFileSize } from '../../utils/file.js'

const execFileAsync = promisify(execFile)

const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024 // 100 MB

export function parsePDFPageRange(
  pages: string,
): { firstPage: number; lastPage: number } | null {
  const trimmed = pages.trim()
  if (!trimmed) {
    return null
  }

  // "N-" 开放区间
  if (trimmed.endsWith('-')) {
    const first = parseInt(trimmed.slice(0, -1), 10)
    if (isNaN(first) || first < 1) {
      return null
    }
    return { firstPage: first, lastPage: Infinity }
  }

  const dashIndex = trimmed.indexOf('-')
  if (dashIndex === -1) {
    // 单页 "5"
    const page = parseInt(trimmed, 10)
    if (isNaN(page) || page < 1) {
      return null
    }
    return { firstPage: page, lastPage: page }
  }

  // 区间 "1-10"
  const first = parseInt(trimmed.slice(0, dashIndex), 10)
  const last = parseInt(trimmed.slice(dashIndex + 1), 10)
  if (isNaN(first) || isNaN(last) || first < 1 || last < 1 || last < first) {
    return null
  }
  return { firstPage: first, lastPage: last }
}

async function run(
  cmd: string,
  args: string[],
  timeout: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout })
    return { code: 0, stdout, stderr }
  } catch (e) {
    const err = e as { code?: number | string; stdout?: string; stderr?: string }
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? String(e),
    }
  }
}

let pdftoppmAvailable: boolean | undefined

export async function isPdftoppmAvailable(): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  const { code, stderr } = await run('pdftoppm', ['-v'], 5000)
  // pdftoppm 的版本信息打到 stderr 且退出码可能非 0（老版本 99）
  pdftoppmAvailable = code === 0 || stderr.length > 0
  return pdftoppmAvailable
}

/** 用 pdfinfo 取页数，不可用时返回 null */
export async function getPDFPageCount(filePath: string): Promise<number | null> {
  const { code, stdout } = await run('pdfinfo', [filePath], 10_000)
  if (code !== 0) {
    return null
  }
  const match = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!match) {
    return null
  }
  const count = parseInt(match[1]!, 10)
  return isNaN(count) ? null : count
}

export type PDFExtractResult = {
  /** 每页一张 JPEG */
  pageBuffers: Buffer[]
  originalSize: number
  outputDir: string
}

/**
 * 把 PDF 页面渲染成 100dpi JPEG（page-01.jpg, page-02.jpg, ...）。
 * 页码 1-indexed，闭区间。
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFExtractResult> {
  const stats = await stat(filePath)
  const originalSize = stats.size

  if (originalSize === 0) {
    throw new Error(`PDF file is empty: ${filePath}`)
  }
  if (originalSize > PDF_MAX_EXTRACT_SIZE) {
    throw new Error(
      `PDF file exceeds maximum allowed size (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
    )
  }

  if (!(await isPdftoppmAvailable())) {
    throw new Error(
      'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.',
    )
  }

  const outputDir = join(tmpdir(), `ccm-pdf-${randomUUID()}`)
  await mkdir(outputDir, { recursive: true })

  const prefix = join(outputDir, 'page')
  const args = ['-jpeg', '-r', '100']
  if (options?.firstPage) {
    args.push('-f', String(options.firstPage))
  }
  if (options?.lastPage && options.lastPage !== Infinity) {
    args.push('-l', String(options.lastPage))
  }
  args.push(filePath, prefix)

  const { code, stderr } = await run('pdftoppm', args, 120_000)
  if (code !== 0) {
    if (/password/i.test(stderr)) {
      throw new Error(
        'PDF is password-protected. Please provide an unprotected version.',
      )
    }
    if (/damaged|corrupt|invalid/i.test(stderr)) {
      throw new Error('PDF file is corrupted or invalid.')
    }
    throw new Error(`pdftoppm failed: ${stderr}`)
  }

  const entries = await readdir(outputDir)
  const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
  if (imageFiles.length === 0) {
    throw new Error('pdftoppm produced no output pages. The PDF may be invalid.')
  }

  const pageBuffers = await Promise.all(
    imageFiles.map(f => readFile(join(outputDir, f))),
  )
  return { pageBuffers, originalSize, outputDir }
}
