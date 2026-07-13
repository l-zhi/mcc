// trace 数据模型。三层嵌套对应 agent 链路的天然结构：
//   Session（一次 REPL 运行）→ Turn（一次用户输入）→ Step（一次 LLM 调用）
// NDJSON 落盘时「一行 = 一个 Turn」，每行自包含 session 元信息便于 viewer 分组。

/** 单次 LLM 调用的 token 用量（原样取自 OpenAI usage，不做累加） */
export type StepTokens = {
  prompt: number
  completion: number
}

/** 一次工具调用的记录 */
export type ToolCallTrace = {
  id: string
  name: string
  /** 解析后的入参对象；解析失败时退化为原始字符串 */
  arguments: unknown
  durationMs: number
  /** 工具结果文本预览（截断，图片/PDF 的 base64 不入 trace） */
  resultPreview: string
  /** 结果文本完整字节数（预览截断了，用它看真实体量） */
  resultBytes: number
  isError: boolean
}

/** 发给模型的一条消息（trace 展示用，内容截断） */
export type TracedMessage = {
  role: string
  /** 文本内容（截断后） */
  content: string
  /** assistant 的 tool_calls 概要 */
  toolCalls?: { name: string; args: string }[]
  /** tool 消息对应的 tool_call id */
  toolCallId?: string
}

/** 一个 Step = 一次 LLM 调用 + 它触发的工具调用 */
export type StepTrace = {
  stepIndex: number
  llm: {
    durationMs: number
    /** 可能为空：部分兼容端点不返回 usage */
    tokens?: StepTokens
    /** 模型这一步的文本：带 tool_calls 时是「边想边说」，末步是最终答案 */
    content: string
    /** 结束原因：优先取端点真实 finish_reason（stop/length/tool_calls…），缺失时推导 */
    finishReason: string
  }
  /** 本次调用实际发出的历史消息（不含 system，system 在 turn 级存一份） */
  request?: TracedMessage[]
  toolCalls: ToolCallTrace[]
}

export type TurnStatus = 'ok' | 'error' | 'truncated' | 'interrupted'

/** 一个 Turn = 一次用户输入的完整处理，NDJSON 里的一行 */
export type TurnTrace = {
  sessionId: string
  model: string
  cwd: string
  turnIndex: number
  userInput: string
  startedAt: number
  durationMs: number
  status: TurnStatus
  /** 本轮的 system 提示词（含加载的 CLAUDE.md 记忆），每轮存一份 */
  systemPrompt?: string
  /** 本轮可用的工具名列表 */
  toolNames?: string[]
  /** 出错时的信息（status === 'error'） */
  errorMessage?: string
  /**
   * 汇总口径见方案：completion 求和（真实生成量），
   * promptLast 取最后一步的 prompt（代表本轮最终上下文大小），prompt 不累加避免重复计。
   */
  tokens: {
    completion: number
    promptLast: number
  }
  steps: StepTrace[]
}
