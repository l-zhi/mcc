// 工具抽象层，裁剪自参考项目 src/Tool.ts 的 buildTool 模式。
// 保留核心形状：name / description(短) / prompt(给模型的长描述) / inputSchema / call。
// 去掉了参考实现中的 UI 渲染、权限、并发安全等挂点（见 stubs.ts 的日志桩）。
import { z } from 'zod'
import type { ChatMessage, ToolSpec } from './api.js'

export type ToolResult = {
  /** 作为 role:"tool" 消息回填给模型的文本内容 */
  content: string
  /**
   * 需要额外注入对话的消息（OpenAI 协议 tool 消息只能是文本，
   * 图片/PDF 页面等多模态内容通过追加 user 消息注入，对齐参考项目的 newMessages 机制）
   */
  newMessages?: ChatMessage[]
}

/** 工具执行上下文。第二个可选参数，老工具不声明它也不影响类型（形参更少可赋值） */
export type ToolContext = {
  /** 当前轮的中断信号：长耗时工具（如 Bash）应透传/监听它，Ctrl+C 时及时停止 */
  signal?: AbortSignal
}

export type ToolDef<S extends z.ZodType = z.ZodType> = {
  name: string
  description: string
  prompt: string
  inputSchema: S
  isReadOnly(): boolean
  call(input: z.infer<S>, ctx?: ToolContext): Promise<ToolResult>
}

export type Tool = ToolDef

export function buildTool<S extends z.ZodType>(def: ToolDef<S>): Tool {
  return def as Tool
}

/** zod schema → OpenAI tools 参数需要的 JSON Schema（zod v4 内置能力） */
export function toOpenAIToolSpec(tool: Tool): ToolSpec {
  const jsonSchema = z.toJSONSchema(tool.inputSchema) as Record<string, unknown>
  delete jsonSchema.$schema
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.prompt,
      parameters: jsonSchema,
    },
  }
}
