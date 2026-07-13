// Edit 工具，裁剪自参考项目 src/tools/FileEditTool/FileEditTool.ts（625 行）。
// 保留（核心逻辑）：
//   - 卷曲引号归一匹配（findActualString）+ 新串引号风格保持（preserveQuoteStyle）
//   - 唯一性校验：old_string 命中多处但 replace_all=false → 拒绝
//   - 先读后写 + 过期检测（与参考 validateInput / call 一致，含全量读内容兜底）
//   - old_string==='' 的新建 / 已存在文件保护；.ipynb 转投 NotebookEdit
//   - 写后回写 readFileState，避免连续 Edit 被自己拦截
// 结构调整：参考把校验放在独立的 validateInput 钩子（返回 behavior:'ask'+errorCode），
//   mini 的 Tool 只有 call()，故把校验折进 call() 并以 throw Error 回报（对齐 FileWriteTool）。
// 桩化：权限（query 层）、skills 发现、LSP/VSCode 通知、文件历史备份、埋点。
// 未移植：团队记忆秘钥扫描、UNC 路径防护、编码检测（统一 utf8/LF）、
//        原子写+fsync（用普通 writeFile）、git diff 展示、结构化 patch（无 diff 包）。
import { mkdir, readFile, stat, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { z } from 'zod'
import { readFileState } from '../../readFileState.js'
import { buildTool, type ToolResult } from '../../Tool.js'
import {
  discoverSkillsStub,
  fileHistoryStub,
  logEventStub,
  notifyIdeStub,
} from '../../stubs.js'
import { expandPath, findSimilarFile, formatFileSize } from '../../utils/file.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../NotebookEditTool/prompt.js'
import { FILE_EDIT_TOOL_NAME, FILE_UNEXPECTEDLY_MODIFIED_ERROR } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'
import { applyEdit, findActualString, preserveQuoteStyle } from './utils.js'

// V8 字符串长度上限约 2^30 字符（~10 亿）。1 GiB 是安全的字节级护栏，
// 防 OOM 又不至于太苛刻（对齐参考 MAX_EDIT_FILE_SIZE）。
const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024 // 1 GiB

const inputSchema = z.object({
  file_path: z
    .string()
    .describe('The absolute path to the file to modify'),
  old_string: z.string().describe('The text to replace'),
  new_string: z
    .string()
    .describe('The text to replace it with (must be different from old_string)'),
  replace_all: z
    .boolean()
    .default(false)
    .optional()
    .describe('Replace all occurrences of old_string (default false)'),
})

export const FileEditTool = buildTool({
  name: FILE_EDIT_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return false
  },
  async call({
    file_path,
    old_string,
    new_string,
    replace_all = false,
  }): Promise<ToolResult> {
    const fullFilePath = expandPath(file_path)

    // 框架挂点（真实现见参考项目，这里是日志桩）
    discoverSkillsStub(fullFilePath)

    // --- 参数级校验（对齐参考 validateInput errorCode 1） ---
    if (old_string === new_string) {
      throw new Error(
        'No changes to make: old_string and new_string are exactly the same.',
      )
    }

    // --- 读取文件当前内容 + 大小护栏（对齐参考 errorCode 10） ---
    let fileContent: string | null = null
    let fileMtimeMs: number | null = null
    try {
      const stats = await stat(fullFilePath)
      if (stats.size > MAX_EDIT_FILE_SIZE) {
        throw new Error(
          `File is too large to edit (${formatFileSize(stats.size)}). Maximum editable file size is ${formatFileSize(MAX_EDIT_FILE_SIZE)}.`,
        )
      }
      fileMtimeMs = Math.floor(stats.mtimeMs)
      // 去 UTF-8 BOM 的 utf16le 情况在 mini 简化为 utf8/LF：读文本并归一 CRLF
      const raw = await readFile(fullFilePath, 'utf-8')
      fileContent = raw.replaceAll('\r\n', '\n')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      // 文件不存在 → 保持 fileContent=null
    }

    // --- 文件不存在（对齐参考 errorCode 4） ---
    if (fileContent === null) {
      // old_string 为空 = 新建文件，放行
      if (old_string === '') {
        return await writeAndReport({
          fullFilePath,
          file_path,
          updatedFile: new_string,
          isUpdate: false,
          old_string,
          new_string,
          replace_all,
        })
      }
      const similar = findSimilarFile(fullFilePath)
      let message = `File does not exist. Current working directory is ${process.cwd()}.`
      if (similar) message += ` Did you mean ${similar}?`
      throw new Error(message)
    }

    // --- 文件已存在 + old_string 为空（对齐参考 errorCode 3） ---
    if (old_string === '') {
      if (fileContent.trim() !== '') {
        throw new Error('Cannot create new file - file already exists.')
      }
      // 空文件 + 空 old_string → 用 new_string 填充
      return await writeAndReport({
        fullFilePath,
        file_path,
        updatedFile: new_string,
        isUpdate: true,
        old_string,
        new_string,
        replace_all,
      })
    }

    // --- .ipynb 转投 NotebookEdit（对齐参考 errorCode 5） ---
    if (fullFilePath.endsWith('.ipynb')) {
      throw new Error(
        `File is a Jupyter Notebook. Use the ${NOTEBOOK_EDIT_TOOL_NAME} to edit this file.`,
      )
    }

    // --- 先读后写 + 过期检测（对齐参考 errorCode 6/7） ---
    const lastRead = readFileState.get(fullFilePath)
    if (!lastRead || lastRead.isPartialView) {
      throw new Error(
        'File has not been read yet. Read it first before writing to it.',
      )
    }
    if (fileMtimeMs !== null && fileMtimeMs > lastRead.timestamp) {
      // 时间戳变新不代表内容变了（云同步/杀毒只碰 mtime），全量读场景比对内容兜底
      const isFullRead =
        lastRead.offset === undefined && lastRead.limit === undefined
      if (!(isFullRead && fileContent === lastRead.content)) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }
    }

    // --- 定位实际匹配串（兼容卷曲引号归一，对齐参考 errorCode 8） ---
    const actualOldString = findActualString(fileContent, old_string)
    if (!actualOldString) {
      throw new Error(
        `String to replace not found in file.\nString: ${old_string}`,
      )
    }

    // --- 唯一性校验（对齐参考 errorCode 9） ---
    const matches = fileContent.split(actualOldString).length - 1
    if (matches > 1 && !replace_all) {
      throw new Error(
        `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}`,
      )
    }

    // --- 应用编辑（保持文件原有引号风格） ---
    const actualNewString = preserveQuoteStyle(
      old_string,
      actualOldString,
      new_string,
    )
    const updatedFile = applyEdit({
      fileContents: fileContent,
      oldString: actualOldString,
      newString: actualNewString,
      replaceAll: replace_all,
    })

    return await writeAndReport({
      fullFilePath,
      file_path,
      updatedFile,
      isUpdate: true,
      old_string,
      new_string,
      replace_all,
    })
  },
})

/** 写盘 + 回写读状态 + 埋点 + 生成结果文案（对齐参考 call 末段 + mapToolResultToToolResultBlockParam） */
async function writeAndReport({
  fullFilePath,
  file_path,
  updatedFile,
  isUpdate,
  old_string,
  new_string,
  replace_all,
}: {
  fullFilePath: string
  file_path: string
  updatedFile: string
  isUpdate: boolean
  old_string: string
  new_string: string
  replace_all: boolean
}): Promise<ToolResult> {
  fileHistoryStub(fullFilePath)
  await mkdir(dirname(fullFilePath), { recursive: true })
  // 参考用 writeTextContent（原子写 + fsync + 编码/换行保持），mini 简化为普通 writeFile
  await writeFile(fullFilePath, updatedFile, 'utf-8')

  notifyIdeStub(fullFilePath)

  // 写后回写读状态（内容 + 新 mtime），否则下一次 Edit/Write 会被自己这次写拦截
  readFileState.set(fullFilePath, {
    content: updatedFile,
    timestamp: Math.floor((await stat(fullFilePath)).mtimeMs),
    offset: undefined,
    limit: undefined,
    isPartialView: false,
  })

  logEventStub('tengu_edit_string_lengths', {
    oldStringBytes: Buffer.byteLength(old_string, 'utf8'),
    newStringBytes: Buffer.byteLength(new_string, 'utf8'),
    replaceAll: replace_all,
  })

  // 结果文案与参考 mapToolResultToToolResultBlockParam 一致
  if (replace_all) {
    return {
      content: `The file ${file_path} has been updated. All occurrences were successfully replaced.`,
    }
  }
  return {
    content: isUpdate
      ? `The file ${file_path} has been updated successfully.`
      : `File created successfully at: ${file_path}`,
  }
}
