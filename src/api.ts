// 裸 fetch 实现的 OpenAI 兼容 chat/completions 客户端（非流式）。
// 不用 openai SDK，为了看清协议本身；streaming 留作后续迭代。
import type { Config } from './config.js'
import { dumpRequestIfEnabled } from './contextLog.js'

// --- OpenAI 协议消息类型 ---

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type ToolSpec = {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export type AssistantResponse = {
  content: string | null
  tool_calls?: ToolCall[]
  usage?: { prompt_tokens: number; completion_tokens: number }
  /**
   * 本次生成的结束原因（原样取自端点）：
   *   'stop'        正常结束
   *   'length'      撞到 max_tokens 被截断（输出不完整！）
   *   'tool_calls'  以工具调用结束
   * 部分兼容端点可能返回其它值或不返回（undefined）。
   */
  finish_reason?: string
}

// --- 请求 ---

export async function chatCompletion(
  config: Config,
  messages: ChatMessage[],
  tools: ToolSpec[],
  signal?: AbortSignal,
): Promise<AssistantResponse> {
  const requestBody = {
    model: config.model,
    messages,
    ...(tools.length > 0 && { tools }),
    // 显式设上限，避免端点默认（常 ~4096）把大文件写到一半截断
    max_tokens: config.maxTokens,
    stream: false,
  }
  // MCC_DEBUG_REQUEST=1 时转储完整请求（system + messages + tools）到 last-request.json
  dumpRequestIfEnabled(requestBody)

  const res = await fetch(`${config.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    // Ctrl+C 时 abort：正在等模型响应也能立刻中断
    signal,
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`API 请求失败 (HTTP ${res.status}): ${body.slice(0, 2000)}`)
  }

  const json = (await res.json()) as {
    choices?: {
      message?: { content?: string | null; tool_calls?: ToolCall[] }
      finish_reason?: string
    }[]
    usage?: { prompt_tokens: number; completion_tokens: number }
  }

  const choice = json.choices?.[0]
  const message = choice?.message
  if (!message) {
    throw new Error(`API 响应缺少 choices[0].message: ${JSON.stringify(json).slice(0, 500)}`)
  }

  return {
    content: message.content ?? null,
    tool_calls: message.tool_calls,
    usage: json.usage,
    finish_reason: choice.finish_reason,
  }
}
