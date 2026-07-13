// Grep 工具，裁剪自参考项目 src/tools/GrepTool/GrepTool.ts（577 行）。
// 保留：全部输入参数与 rg 参数组装（VCS 目录排除、--max-columns 500、
//      dash pattern 用 -e 防选项注入、glob 逗号/空格拆分但保留花括号）、
//      三种输出模式后处理（先截断再加工、files 按 mtime 降序、相对路径转换、
//      分页提示文案）、路径不存在时的 cwd 提示。
// 桩化：权限（query 层）、权限 ignore 模式注入（无权限系统，无模式可注入）。
// 未移植：semanticNumber/semanticBoolean 宽松解析、UNC 防护、插件缓存排除、
//        suggestPathUnderCwd（用 findSimilarFile 近似）。
import { stat } from 'fs/promises'
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { logEventStub } from '../../stubs.js'
import {
  expandPath,
  FILE_NOT_FOUND_CWD_NOTE,
  toRelativePath,
} from '../../utils/file.js'
import { ripGrep } from '../../utils/ripgrep.js'
import { DESCRIPTION, GREP_TOOL_NAME, PROMPT } from './prompt.js'

// 自动排除的版本控制元数据目录（copy 自参考 VCS_DIRECTORIES_TO_EXCLUDE）
const VCS_DIRECTORIES_TO_EXCLUDE = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl']

// head_limit 缺省值：无限制的 content 搜索可能一次吃掉数千行输出，
// 250 对探索式搜索足够宽松（对齐参考 DEFAULT_HEAD_LIMIT 及其注释）
const DEFAULT_HEAD_LIMIT = 250

const inputSchema = z.object({
  pattern: z
    .string()
    .describe('The regular expression pattern to search for in file contents'),
  path: z
    .string()
    .optional()
    .describe(
      'File or directory to search in (rg PATH). Defaults to current working directory.',
    ),
  glob: z
    .string()
    .optional()
    .describe(
      'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
    ),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
    ),
  '-B': z
    .number()
    .optional()
    .describe(
      'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
    ),
  '-A': z
    .number()
    .optional()
    .describe(
      'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
    ),
  '-C': z.number().optional().describe('Alias for context.'),
  context: z
    .number()
    .optional()
    .describe(
      'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
    ),
  '-n': z
    .boolean()
    .optional()
    .describe(
      'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
    ),
  '-i': z.boolean().optional().describe('Case insensitive search (rg -i)'),
  type: z
    .string()
    .optional()
    .describe(
      'File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.',
    ),
  head_limit: z
    .number()
    .optional()
    .describe(
      `Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes. Defaults to ${DEFAULT_HEAD_LIMIT} when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).`,
    ),
  offset: z
    .number()
    .optional()
    .describe(
      'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
    ),
  multiline: z
    .boolean()
    .optional()
    .describe(
      'Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.',
    ),
})

// copy 自参考 applyHeadLimit：显式 0 = 不限的逃生舱；
// 只在真发生截断时回报 appliedLimit，模型据此知道可以用 offset 翻页
function applyHeadLimit<T>(
  items: T[],
  limit: number | undefined,
  offset: number = 0,
): { items: T[]; appliedLimit: number | undefined } {
  if (limit === 0) {
    return { items: items.slice(offset), appliedLimit: undefined }
  }
  const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT
  const sliced = items.slice(offset, offset + effectiveLimit)
  const wasTruncated = items.length - offset > effectiveLimit
  return {
    items: sliced,
    appliedLimit: wasTruncated ? effectiveLimit : undefined,
  }
}

function formatLimitInfo(
  appliedLimit: number | undefined,
  appliedOffset: number,
): string {
  const parts: string[] = []
  if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`)
  if (appliedOffset) parts.push(`offset: ${appliedOffset}`)
  return parts.join(', ')
}

export const GrepTool = buildTool({
  name: GREP_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return true
  },
  async call({
    pattern,
    path,
    glob,
    type,
    output_mode = 'files_with_matches',
    '-B': contextBefore,
    '-A': contextAfter,
    '-C': contextC,
    context,
    '-n': showLineNumbers = true,
    '-i': caseInsensitive = false,
    head_limit,
    offset = 0,
    multiline = false,
  }): Promise<ToolResult> {
    // --- 路径校验（对齐参考 validateInput） ---
    const absolutePath = path ? expandPath(path) : process.cwd()
    if (path) {
      try {
        await stat(absolutePath)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(
            `Path does not exist: ${path}. ${FILE_NOT_FOUND_CWD_NOTE} ${process.cwd()}.`,
          )
        }
        throw e
      }
    }

    // --- rg 参数组装（copy 自参考 call :329-434） ---
    const args = ['--hidden']
    for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
      args.push('--glob', `!${dir}`)
    }
    // 防 base64/minified 超长行灌爆输出
    args.push('--max-columns', '500')

    if (multiline) {
      args.push('-U', '--multiline-dotall')
    }
    if (caseInsensitive) {
      args.push('-i')
    }
    if (output_mode === 'files_with_matches') {
      args.push('-l')
    } else if (output_mode === 'count') {
      args.push('-c')
    }
    if (showLineNumbers && output_mode === 'content') {
      args.push('-n')
    }
    // context/-C 优先于 -B/-A
    if (output_mode === 'content') {
      if (context !== undefined) {
        args.push('-C', context.toString())
      } else if (contextC !== undefined) {
        args.push('-C', contextC.toString())
      } else {
        if (contextBefore !== undefined) {
          args.push('-B', contextBefore.toString())
        }
        if (contextAfter !== undefined) {
          args.push('-A', contextAfter.toString())
        }
      }
    }
    // pattern 以 - 开头时用 -e 传入，防止被 rg 当成命令行选项
    if (pattern.startsWith('-')) {
      args.push('-e', pattern)
    } else {
      args.push(pattern)
    }
    if (type) {
      args.push('--type', type)
    }
    if (glob) {
      // 逗号/空格拆分多模式，但带花括号的模式（*.{ts,tsx}）不拆
      const globPatterns: string[] = []
      for (const rawPattern of glob.split(/\s+/)) {
        if (rawPattern.includes('{') && rawPattern.includes('}')) {
          globPatterns.push(rawPattern)
        } else {
          globPatterns.push(...rawPattern.split(',').filter(Boolean))
        }
      }
      for (const globPattern of globPatterns.filter(Boolean)) {
        args.push('--glob', globPattern)
      }
    }
    // 参考实现在此注入权限系统的 read-ignore 模式（--glob '!**/pattern'），
    // mini 没有权限系统，无模式可注入（真实现落地时在这里补）

    const results = await ripGrep(args, absolutePath)
    logEventStub('grep_search', {
      mode: output_mode,
      resultCount: results.length,
    })

    // --- content 模式：命中行本身 ---
    if (output_mode === 'content') {
      // 先截断再加工：相对路径转换是逐行工作，别浪费在要丢弃的行上
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )
      const finalLines = limitedResults.map(line => {
        // 行格式：/absolute/path:num:content，按第一个冒号切分
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          return (
            toRelativePath(line.substring(0, colonIndex)) +
            line.substring(colonIndex)
          )
        }
        return line
      })

      const limitInfo = formatLimitInfo(appliedLimit, offset)
      const resultContent = finalLines.join('\n') || 'No matches found'
      return {
        content: limitInfo
          ? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
          : resultContent,
      }
    }

    // --- count 模式：path:count，按最后一个冒号切分（路径可含冒号） ---
    if (output_mode === 'count') {
      const { items: limitedResults, appliedLimit } = applyHeadLimit(
        results,
        head_limit,
        offset,
      )
      let totalMatches = 0
      let fileCount = 0
      const finalCountLines = limitedResults.map(line => {
        const colonIndex = line.lastIndexOf(':')
        if (colonIndex > 0) {
          const count = parseInt(line.substring(colonIndex + 1), 10)
          if (!isNaN(count)) {
            totalMatches += count
            fileCount += 1
          }
          return (
            toRelativePath(line.substring(0, colonIndex)) +
            line.substring(colonIndex)
          )
        }
        return line
      })

      const limitInfo = formatLimitInfo(appliedLimit, offset)
      const summary = `\n\nFound ${totalMatches} total ${totalMatches === 1 ? 'occurrence' : 'occurrences'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}.${limitInfo ? ` with pagination = ${limitInfo}` : ''}`
      return { content: (finalCountLines.join('\n') || 'No matches found') + summary }
    }

    // --- files_with_matches 模式（默认）：按 mtime 降序 ---
    // allSettled：单个文件在 rg 扫描与 stat 之间被删除不炸整批，失败的按 mtime 0 排
    const stats = await Promise.allSettled(results.map(f => stat(f)))
    const sortedMatches = results
      .map((f, i) => {
        const r = stats[i]!
        return [f, r.status === 'fulfilled' ? r.value.mtimeMs : 0] as const
      })
      .sort((a, b) => {
        const timeComparison = b[1] - a[1]
        // mtime 相同按文件名，保证确定性
        return timeComparison === 0 ? a[0].localeCompare(b[0]) : timeComparison
      })
      .map(([f]) => f)

    const { items: finalMatches, appliedLimit } = applyHeadLimit(
      sortedMatches,
      head_limit,
      offset,
    )
    if (finalMatches.length === 0) {
      return { content: 'No files found' }
    }
    const limitInfo = formatLimitInfo(appliedLimit, offset)
    return {
      content: `Found ${finalMatches.length} ${finalMatches.length === 1 ? 'file' : 'files'}${limitInfo ? ` ${limitInfo}` : ''}\n${finalMatches.map(toRelativePath).join('\n')}`,
    }
  },
})
