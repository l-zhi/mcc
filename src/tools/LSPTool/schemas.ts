// LSP 操作的判别联合，裁剪自参考项目 src/tools/LSPTool/schemas.ts（216 行）。
// 保留：以 operation 为判别键的 discriminatedUnion（用于 call 里更好的校验报错）。
// 简化：参考项目九个变体逐个手写（字段完全相同），mini 用共享字段构造器压缩，
//      语义等价。
import { z } from 'zod'

const OPERATIONS = [
  'goToDefinition',
  'findReferences',
  'hover',
  'documentSymbol',
  'workspaceSymbol',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
] as const

export type LSPOperation = (typeof OPERATIONS)[number]

// 每个变体字段相同：filePath + line + character，仅 operation 字面量不同
const variant = (op: LSPOperation) =>
  z.strictObject({
    operation: z.literal(op),
    filePath: z.string().describe('The absolute or relative path to the file'),
    line: z
      .number()
      .int()
      .positive()
      .describe('The line number (1-based, as shown in editors)'),
    character: z
      .number()
      .int()
      .positive()
      .describe('The character offset (1-based, as shown in editors)'),
  })

export const lspToolInputSchema = z.discriminatedUnion(
  'operation',
  OPERATIONS.map(variant) as [
    ReturnType<typeof variant>,
    ...ReturnType<typeof variant>[],
  ],
)

export { OPERATIONS }
