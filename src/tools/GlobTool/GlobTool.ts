// Glob 工具，裁剪自参考项目 src/tools/GlobTool/GlobTool.ts（198 行）。
// 保留：pattern + 可选 path 两参数、绝对/相对路径解析、path 校验（存在且是目录）、
//      结果上限 100、相对路径转换省 token、truncated 提示文案。
// 桩化：权限（query 层）。
// 未移植：UNC 防护、suggestPathUnderCwd（用 findSimilarFile 近似）、durationMs/
//        numFiles 统计（参考仅用于 UI chrome）、lazySchema。
import { stat } from 'fs/promises'
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { logEventStub } from '../../stubs.js'
import {
  expandPath,
  FILE_NOT_FOUND_CWD_NOTE,
  findSimilarFile,
  toRelativePath,
} from '../../utils/file.js'
import { glob } from '../../utils/glob.js'
import { DESCRIPTION, GLOB_TOOL_NAME, PROMPT } from './prompt.js'

// 对齐参考 globLimits?.maxResults ?? 100
const DEFAULT_LIMIT = 100

const inputSchema = z.object({
  pattern: z.string().describe('The glob pattern to match files against'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.',
    ),
})

export const GlobTool = buildTool({
  name: GLOB_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return true
  },
  async call({ pattern, path }): Promise<ToolResult> {
    const searchDir = path ? expandPath(path) : process.cwd()

    // --- path 校验（对齐参考 validateInput：存在 + 是目录） ---
    if (path) {
      let stats
      try {
        stats = await stat(searchDir)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          const suggestion = findSimilarFile(searchDir)
          throw new Error(
            `Directory does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.` +
              (suggestion ? ` Did you mean ${suggestion}?` : ''),
          )
        }
        throw e
      }
      if (!stats.isDirectory()) {
        throw new Error(`Path is not a directory: ${path}`)
      }
    }

    const { files, truncated } = await glob(pattern, searchDir, {
      limit: DEFAULT_LIMIT,
      offset: 0,
    })

    logEventStub('glob_search', { resultCount: files.length, truncated })

    if (files.length === 0) {
      return { content: 'No files found' }
    }

    // 相对路径省 token（对齐参考 files.map(toRelativePath)）
    const lines = files.map(toRelativePath)
    if (truncated) {
      lines.push(
        '(Results are truncated. Consider using a more specific path or pattern.)',
      )
    }
    return { content: lines.join('\n') }
  },
})
