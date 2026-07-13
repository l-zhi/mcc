// Jupyter notebook 读取，裁剪自参考项目 src/utils/notebook.ts。
// 保留：cell 处理、<cell id=...> 文本格式、输出截断、图片输出提取。
// 简化：文本输出截断用固定阈值（参考实现走 BashTool formatOutput 的通用截断）。
import { readFile } from 'fs/promises'

const LARGE_OUTPUT_THRESHOLD = 10_000
const MAX_OUTPUT_TEXT = 10_000

type NotebookOutputImage = { image_data: string; media_type: string }

type ProcessedOutput = {
  output_type: string
  text?: string
  image?: NotebookOutputImage
}

type ProcessedCell = {
  cellType: string
  cell_id: string
  source: string
  language?: string
  execution_count?: number
  outputs?: ProcessedOutput[]
}

type RawCell = {
  id?: string
  cell_type: string
  source: string | string[]
  execution_count?: number | null
  outputs?: RawOutput[]
}

type RawOutput = {
  output_type: string
  text?: string | string[]
  data?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
}

function processOutputText(text: string | string[] | undefined): string {
  if (!text) return ''
  const rawText = Array.isArray(text) ? text.join('') : text
  if (rawText.length > MAX_OUTPUT_TEXT) {
    return rawText.slice(0, MAX_OUTPUT_TEXT) + '... (output truncated)'
  }
  return rawText
}

function extractImage(
  data: Record<string, unknown>,
): NotebookOutputImage | undefined {
  if (typeof data['image/png'] === 'string') {
    return {
      image_data: data['image/png'].replace(/\s/g, ''),
      media_type: 'image/png',
    }
  }
  if (typeof data['image/jpeg'] === 'string') {
    return {
      image_data: data['image/jpeg'].replace(/\s/g, ''),
      media_type: 'image/jpeg',
    }
  }
  return undefined
}

function processOutput(output: RawOutput): ProcessedOutput {
  switch (output.output_type) {
    case 'stream':
      return {
        output_type: output.output_type,
        text: processOutputText(output.text),
      }
    case 'execute_result':
    case 'display_data':
      return {
        output_type: output.output_type,
        text: processOutputText(output.data?.['text/plain'] as string | string[] | undefined),
        image: output.data && extractImage(output.data),
      }
    case 'error':
      return {
        output_type: output.output_type,
        text: processOutputText(
          `${output.ename}: ${output.evalue}\n${(output.traceback ?? []).join('\n')}`,
        ),
      }
    default:
      return { output_type: output.output_type }
  }
}

function isLargeOutputs(outputs: ProcessedOutput[]): boolean {
  let size = 0
  for (const o of outputs) {
    size += (o.text?.length ?? 0) + (o.image?.image_data.length ?? 0)
    if (size > LARGE_OUTPUT_THRESHOLD) return true
  }
  return false
}

function processCell(
  cell: RawCell,
  index: number,
  codeLanguage: string,
): ProcessedCell {
  const cellData: ProcessedCell = {
    cellType: cell.cell_type,
    cell_id: cell.id ?? `cell-${index}`,
    source: Array.isArray(cell.source) ? cell.source.join('') : cell.source,
    execution_count:
      cell.cell_type === 'code' ? cell.execution_count || undefined : undefined,
  }
  if (cell.cell_type === 'code') {
    cellData.language = codeLanguage
  }

  if (cell.cell_type === 'code' && cell.outputs?.length) {
    const outputs = cell.outputs.map(processOutput)
    if (isLargeOutputs(outputs)) {
      cellData.outputs = [
        {
          output_type: 'stream',
          text: `Outputs are too large to include. Read specific outputs from the raw notebook JSON instead (.cells[${index}].outputs).`,
        },
      ]
    } else {
      cellData.outputs = outputs
    }
  }

  return cellData
}

export type NotebookReadResult = {
  /** 拼好的 <cell id=...> 文本，作为 tool 消息内容 */
  text: string
  /** cell 输出里的图片（data URI），通过 user 消息注入 */
  images: string[]
}

export async function readNotebook(
  notebookPath: string,
): Promise<NotebookReadResult> {
  const content = await readFile(notebookPath, 'utf-8')
  const notebook = JSON.parse(content) as {
    cells: RawCell[]
    metadata?: { language_info?: { name?: string } }
  }
  const language = notebook.metadata?.language_info?.name ?? 'python'
  const cells = notebook.cells.map((cell, index) =>
    processCell(cell, index, language),
  )

  const parts: string[] = []
  const images: string[] = []
  for (const cell of cells) {
    // 对齐参考 cellContentToToolResult 的 <cell> 标签格式
    const metadata: string[] = []
    if (cell.cellType !== 'code') {
      metadata.push(`<cell_type>${cell.cellType}</cell_type>`)
    }
    if (cell.language !== 'python' && cell.cellType === 'code') {
      metadata.push(`<language>${cell.language}</language>`)
    }
    parts.push(
      `<cell id="${cell.cell_id}">${metadata.join('')}${cell.source}</cell id="${cell.cell_id}">`,
    )
    for (const output of cell.outputs ?? []) {
      if (output.text) {
        parts.push(output.text)
      }
      if (output.image) {
        images.push(
          `data:${output.image.media_type};base64,${output.image.image_data}`,
        )
      }
    }
  }

  return { text: parts.join('\n'), images }
}
