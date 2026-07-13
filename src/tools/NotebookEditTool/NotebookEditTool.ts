// NotebookEdit 工具，裁剪自参考项目 src/tools/NotebookEditTool/NotebookEditTool.ts（490 行）。
// 保留（核心逻辑逐条对齐参考 call/validateInput）：
//   - replace / insert / delete 三种编辑模式
//   - cell 定位：先按真实 id 查，查不到再按 cell-N 数字索引（parseCellId）
//   - insert 在目标 cell 之后插入；replace 落在末尾+1 时自动转 insert
//   - nbformat >= 4.5 时给新 cell 生成随机 id；code cell 改动后清空 execution_count/outputs
//   - 先读后写校验 + 过期检测（复用 readFileState，与 FileWriteTool 同一地基）
//   - 写后回写 readFileState，结果文案与参考 mapToolResultToToolResultBlockParam 一致
// 桩化：权限（query 层）、文件历史备份。
// 未移植：编码/换行符保持（统一 utf8）、UNC 防护、memoize 缓存投毒防护
//        （mini 直接 JSON.parse 独立对象，无共享缓存问题）。
import { readFileSync, statSync, writeFileSync } from 'fs'
import { extname, isAbsolute, resolve } from 'path'
import { z } from 'zod'
import { readFileState } from '../../readFileState.js'
import { buildTool, type ToolResult } from '../../Tool.js'
import { fileHistoryStub } from '../../stubs.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from '../FileEditTool/constants.js'
import { DESCRIPTION, NOTEBOOK_EDIT_TOOL_NAME, PROMPT } from './prompt.js'

// --- notebook 结构类型（参考 src/types/notebook.ts 的最小子集） ---
type NotebookCell = {
  cell_type: 'code' | 'markdown'
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  execution_count?: number | null
  outputs?: unknown[]
}
type NotebookContent = {
  cells: NotebookCell[]
  metadata: { language_info?: { name?: string } }
  nbformat: number
  nbformat_minor: number
}

// copy 自参考 utils/notebook.ts parseCellId：把 "cell-N" 解析成数字索引
function parseCellId(cellId: string): number | undefined {
  const match = cellId.match(/^cell-(\d+)$/)
  if (match && match[1]) {
    const index = parseInt(match[1], 10)
    return isNaN(index) ? undefined : index
  }
  return undefined
}

const inputSchema = z.object({
  notebook_path: z
    .string()
    .describe(
      'The absolute path to the Jupyter notebook file to edit (must be absolute, not relative)',
    ),
  cell_id: z
    .string()
    .optional()
    .describe(
      'The ID of the cell to edit. When inserting a new cell, the new cell will be inserted after the cell with this ID, or at the beginning if not specified.',
    ),
  new_source: z.string().describe('The new source for the cell'),
  cell_type: z
    .enum(['code', 'markdown'])
    .optional()
    .describe(
      'The type of the cell (code or markdown). If not specified, it defaults to the current cell type. If using edit_mode=insert, this is required.',
    ),
  edit_mode: z
    .enum(['replace', 'insert', 'delete'])
    .optional()
    .describe(
      'The type of edit to make (replace, insert, delete). Defaults to replace.',
    ),
})

export const NotebookEditTool = buildTool({
  name: NOTEBOOK_EDIT_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  isReadOnly() {
    return false
  },
  async call({
    notebook_path,
    new_source,
    cell_id,
    cell_type,
    edit_mode: originalEditMode = 'replace',
  }): Promise<ToolResult> {
    const fullPath = isAbsolute(notebook_path)
      ? notebook_path
      : resolve(process.cwd(), notebook_path)

    // --- 校验（对齐参考 validateInput 的 errorCode 2/4/5/9/10/1/6/7/8） ---
    if (extname(fullPath) !== '.ipynb') {
      throw new Error(
        'File must be a Jupyter notebook (.ipynb file). For editing other file types, use the Write tool.',
      )
    }
    if (originalEditMode === 'insert' && !cell_type) {
      throw new Error('Cell type is required when using edit_mode=insert.')
    }

    // 先读后写 + 过期检测（复用 readFileState，与 FileWriteTool 同一机制）
    const lastRead = readFileState.get(fullPath)
    if (!lastRead) {
      throw new Error(
        'File has not been read yet. Read it first before writing to it.',
      )
    }
    let mtimeMs: number
    try {
      mtimeMs = Math.floor(statSync(fullPath).mtimeMs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error('Notebook file does not exist.')
      }
      throw e
    }
    if (mtimeMs > lastRead.timestamp) {
      throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
    }

    const content = readFileSync(fullPath, 'utf-8')
    let notebook: NotebookContent
    try {
      notebook = JSON.parse(content) as NotebookContent
    } catch {
      throw new Error('Notebook is not valid JSON.')
    }

    // --- 定位 cell（对齐参考 call） ---
    let cellIndex: number
    if (!cell_id) {
      if (originalEditMode !== 'insert') {
        throw new Error('Cell ID must be specified when not inserting a new cell.')
      }
      cellIndex = 0 // 无 cell_id 时默认插到开头
    } else {
      cellIndex = notebook.cells.findIndex(c => c.id === cell_id)
      if (cellIndex === -1) {
        const parsed = parseCellId(cell_id)
        if (parsed !== undefined) {
          if (!notebook.cells[parsed]) {
            throw new Error(
              `Cell with index ${parsed} does not exist in notebook.`,
            )
          }
          cellIndex = parsed
        } else {
          throw new Error(`Cell with ID "${cell_id}" not found in notebook.`)
        }
      }
      if (originalEditMode === 'insert') {
        cellIndex += 1 // 在该 cell 之后插入
      }
    }

    // replace 落在末尾+1 时自动转 insert（对齐参考）
    let edit_mode = originalEditMode
    if (edit_mode === 'replace' && cellIndex === notebook.cells.length) {
      edit_mode = 'insert'
      if (!cell_type) cell_type = 'code'
    }

    // nbformat >= 4.5 需要 cell id（对齐参考）
    let new_cell_id: string | undefined
    if (
      notebook.nbformat > 4 ||
      (notebook.nbformat === 4 && notebook.nbformat_minor >= 5)
    ) {
      if (edit_mode === 'insert') {
        new_cell_id = Math.random().toString(36).substring(2, 15)
      } else if (cell_id != null) {
        new_cell_id = cell_id
      }
    }

    // --- 应用编辑（对齐参考 splice 逻辑） ---
    if (edit_mode === 'delete') {
      notebook.cells.splice(cellIndex, 1)
    } else if (edit_mode === 'insert') {
      const new_cell: NotebookCell =
        cell_type === 'markdown'
          ? {
              cell_type: 'markdown',
              id: new_cell_id,
              source: new_source,
              metadata: {},
            }
          : {
              cell_type: 'code',
              id: new_cell_id,
              source: new_source,
              metadata: {},
              execution_count: null,
              outputs: [],
            }
      notebook.cells.splice(cellIndex, 0, new_cell)
    } else {
      const targetCell = notebook.cells[cellIndex]! // 上面已保证在界内
      targetCell.source = new_source
      if (targetCell.cell_type === 'code') {
        // cell 改动了，清空执行计数与输出（对齐参考）
        targetCell.execution_count = null
        targetCell.outputs = []
      }
      if (cell_type && cell_type !== targetCell.cell_type) {
        targetCell.cell_type = cell_type
      }
    }

    // --- 写回（参考用 IPYNB_INDENT=1 缩进；编码/换行符保持未移植，统一 utf8） ---
    fileHistoryStub(fullPath)
    const IPYNB_INDENT = 1
    const updatedContent = JSON.stringify(notebook, null, IPYNB_INDENT)
    writeFileSync(fullPath, updatedContent, 'utf-8')

    // 写后回写读状态，否则下一次编辑会被自己这次写拦截（对齐参考）
    readFileState.set(fullPath, {
      content: updatedContent,
      timestamp: Math.floor(statSync(fullPath).mtimeMs),
      offset: undefined,
      limit: undefined,
      isPartialView: false,
    })

    // 结果文案对齐参考 mapToolResultToToolResultBlockParam
    switch (edit_mode) {
      case 'insert':
        return { content: `Inserted cell ${new_cell_id ?? ''} with ${new_source}` }
      case 'delete':
        return { content: `Deleted cell ${cell_id}` }
      default:
        return { content: `Updated cell ${cell_id} with ${new_source}` }
    }
  },
})
