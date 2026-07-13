// Write 工具，裁剪自参考项目 src/tools/FileWriteTool/FileWriteTool.ts（434 行）。
// 保留（核心安全机制）：
//   - 先读后写校验：文件存在但没有 Read 过 → 拒绝
//   - 部分视图拒绝：只读了 offset/limit 片段不允许整文件覆写
//   - 过期检测：磁盘 mtime 比登记的读取时间新 → 先比内容再拒绝
//     （内容相同放行，对齐参考对"时间戳变了内容没变"场景的兜底）
//   - 自动创建父目录；写后回写 readFileState 使连续写不被自己拦截
//   - create / update 两种结果文案（与参考逐字一致）
// 桩化：权限（query 层）、skills 发现、LSP/VSCode 通知、文件历史备份、埋点。
// 未移植：team memory 秘钥扫描、UNC 路径防护（Windows）、编码检测
//        （统一 utf8/LF）、原子写+fsync（用普通 writeFile）、git diff 展示。
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
import { expandPath } from '../../utils/file.js'
// Edit 工具落地后，该常量移到 FileEditTool/constants.ts 共用（Write / Edit 同一份文案）
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { DESCRIPTION, FILE_WRITE_TOOL_NAME, PROMPT } from './prompt.js'

const inputSchema = z.object({
  file_path: z
    .string()
    .describe(
      'The absolute path to the file to write (must be absolute, not relative)',
    ),
  content: z.string().describe('The content to write to the file'),
})

export const FileWriteTool = buildTool({
  name: FILE_WRITE_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return false
  },
  async call({ file_path, content }): Promise<ToolResult> {
    const fullFilePath = expandPath(file_path)

    // 框架挂点（真实现见参考项目，这里是日志桩）
    discoverSkillsStub(fullFilePath)

    // --- 先读后写 + 过期校验（对齐参考 validateInput errorCode 2/3） ---
    let fileMtimeMs: number | null = null
    try {
      fileMtimeMs = Math.floor((await stat(fullFilePath)).mtimeMs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      // 文件不存在 → 新建，无需先读
    }

    if (fileMtimeMs !== null) {
      const lastRead = readFileState.get(fullFilePath)
      if (!lastRead || lastRead.isPartialView) {
        throw new Error(
          'File has not been read yet. Read it first before writing to it.',
        )
      }
      if (fileMtimeMs > lastRead.timestamp) {
        // 时间戳变新不代表内容变了（云同步/杀毒软件等会只碰 mtime），
        // 全量读的场景比对内容兜底，内容一致则放行（对齐参考 call 内的二次校验）
        const currentContent = await readFile(fullFilePath, 'utf-8')
        if (currentContent !== lastRead.content) {
          throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
        }
      }
    }

    // --- 写入 ---
    const isUpdate = fileMtimeMs !== null
    fileHistoryStub(fullFilePath)
    await mkdir(dirname(fullFilePath), { recursive: true })
    // 参考实现用 writeTextContent（临时文件原子写 + fsync + 编码保持），
    // mini 简化为普通 writeFile（utf8/LF，模型给什么写什么）
    await writeFile(fullFilePath, content, 'utf-8')

    notifyIdeStub(fullFilePath)

    // 写后回写读状态（内容 + 新 mtime），否则下一次 Write 会被自己的这次写拦截
    readFileState.set(fullFilePath, {
      content,
      timestamp: Math.floor((await stat(fullFilePath)).mtimeMs),
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    })

    logEventStub('file_write', {
      type: isUpdate ? 'update' : 'create',
      contentLength: content.length,
    })

    // 结果文案与参考 mapToolResultToToolResultBlockParam 逐字一致
    return {
      content: isUpdate
        ? `The file ${file_path} has been updated successfully.`
        : `File created successfully at: ${file_path}`,
    }
  },
})
