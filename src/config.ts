import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type Config = {
  apiKey: string
  baseURL: string
  model: string
  /** 模型上下文窗口（token），用于自动压缩阈值。不同模型不同，可在 config 覆盖 */
  contextWindow: number
  /**
   * 单次响应的最大生成 token（max_tokens）。不设时端点默认常只有 ~4096，
   * 大文件（如整页 HTML 游戏）会被从中截断。可在 config.json 用 maxTokens 覆盖；
   * 若某端点拒绝过大的值，调小它即可。
   */
  maxTokens: number
}

const DEFAULT_CONTEXT_WINDOW = 128_000
// 默认放宽到 16k，避免整页 HTML/大文件写到一半被截断（对齐本项目排查到的 4096 截断问题）
const DEFAULT_MAX_TOKENS = 16_384

export const CONFIG_DIR = join(homedir(), '.mcc')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')

const EXAMPLE_CONFIG = JSON.stringify(
  {
    apiKey: 'sk-...',
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o',
  },
  null,
  2,
)

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

export function loadConfig(): Config {
  if (!existsSync(CONFIG_PATH)) {
    fail(
      `配置文件不存在: ${CONFIG_PATH}\n` +
        `请创建该文件，内容示例:\n${EXAMPLE_CONFIG}`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
  } catch (e) {
    fail(`配置文件不是合法 JSON: ${CONFIG_PATH}\n${(e as Error).message}`)
  }

  const config = parsed as Record<string, unknown>
  for (const key of ['apiKey', 'baseURL', 'model'] as const) {
    if (typeof config[key] !== 'string' || config[key] === '') {
      fail(
        `配置文件缺少字段 "${key}": ${CONFIG_PATH}\n` +
          `完整内容示例:\n${EXAMPLE_CONFIG}`,
      )
    }
  }

  // contextWindow 可选：是正数就用，否则回落默认
  const cw = config.contextWindow
  const contextWindow =
    typeof cw === 'number' && cw > 0 ? cw : DEFAULT_CONTEXT_WINDOW

  // maxTokens 可选：是正数就用，否则回落默认
  const mt = config.maxTokens
  const maxTokens = typeof mt === 'number' && mt > 0 ? mt : DEFAULT_MAX_TOKENS

  return {
    apiKey: config.apiKey as string,
    // 去掉尾部斜杠，拼 /chat/completions 时不重复
    baseURL: (config.baseURL as string).replace(/\/+$/, ''),
    model: config.model as string,
    contextWindow,
    maxTokens,
  }
}
