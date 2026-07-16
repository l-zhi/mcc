// 链路 trace：把每轮对话（Turn）追加成一行 NDJSON（真源、append-only），
// 同时重写 trace-data.js（派生视图，供 viewer 以 <script src> 加载，双击 HTML 即看）。
// 默认开启，MCC_TRACE=0 / false 关闭。文件落在 config 同处的 traces/ 目录。
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'fs'
import { join } from 'path'
import type { Config } from '../config.js'
import { CONFIG_DIR } from '../config.js'
import type {
  StepTokens,
  StepTrace,
  TracedMessage,
  TurnStatus,
  TurnTrace,
} from './types.js'
import { VIEWER_HTML } from './viewerHtml.js'

const TRACES_DIR = join(CONFIG_DIR, 'traces')
const NDJSON_PATH = join(TRACES_DIR, 'trace.ndjson')
const DATA_JS_PATH = join(TRACES_DIR, 'trace-data.js')
const VIEWER_PATH = join(TRACES_DIR, 'trace-viewer.html')

/** 工具结果预览的最大字符数：够看清结果、又不让 base64/长文件灌爆 trace */
const RESULT_PREVIEW_CHARS = 800

function traceEnabled(): boolean {
  const v = process.env.MCC_TRACE
  return v !== '0' && v?.toLowerCase() !== 'false'
}

// completion 求和（真实生成量）；promptLast 取最后一个有 usage 的 step 的 prompt
// （代表本轮最终上下文大小，不累加避免重复计）。endTurn 与增量刷新共用。
function sumTurnTokens(turn: TurnTrace): TurnTrace['tokens'] {
  let completion = 0
  let promptLast = 0
  for (const s of turn.steps) {
    if (!s.llm.tokens) continue
    completion += s.llm.tokens.completion
    promptLast = s.llm.tokens.prompt
  }
  return { completion, promptLast }
}

function makeSessionId(): string {
  const d = new Date()
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  const rand = Math.random().toString(16).slice(2, 6)
  return `${stamp}-${rand}`
}

export class Tracer {
  readonly enabled: boolean
  private readonly sessionId = makeSessionId()
  private readonly model: string
  private readonly cwd = process.cwd()
  /** 内存里累积「本文件所有 session」的 turn，用于每轮重写 trace-data.js */
  private allTurns: TurnTrace[] = []

  private current: TurnTrace | null = null
  private currentStep: StepTrace | null = null

  // opts.disabled：子代理用的静默 tracer——所有方法都会因 enabled=false 而 no-op，
  // 且构造时不碰磁盘。子代理的可视化留到后续迭代（sidechain 嵌套）。
  constructor(config: Config, opts?: { disabled?: boolean }) {
    this.enabled = opts?.disabled ? false : traceEnabled()
    this.model = config.model
    if (!this.enabled) return

    mkdirSync(TRACES_DIR, { recursive: true })
    // 载入历史 turn（viewer 展示所有 session），坏行跳过不致命
    if (existsSync(NDJSON_PATH)) {
      for (const line of readFileSync(NDJSON_PATH, 'utf-8').split('\n')) {
        if (!line.trim()) continue
        try {
          this.allTurns.push(JSON.parse(line) as TurnTrace)
        } catch {
          /* 跳过损坏行 */
        }
      }
    }
    // 每次启动都重写 viewer，使模板更新自然生效
    writeFileSync(VIEWER_PATH, VIEWER_HTML)
    // 保证 data.js 存在（首次运行或历史为空时也能打开 viewer）
    if (!existsSync(DATA_JS_PATH)) this.writeDataJs()
  }

  /** 开始一轮：turnIndex 用「本 session 已记录的轮数」计数 */
  startTurn(userInput: string): void {
    if (!this.enabled) return
    const turnIndex = this.allTurns.filter(
      t => t.sessionId === this.sessionId,
    ).length
    this.current = {
      sessionId: this.sessionId,
      model: this.model,
      cwd: this.cwd,
      turnIndex,
      userInput,
      startedAt: Date.now(),
      durationMs: 0,
      status: 'ok',
      tokens: { completion: 0, promptLast: 0 },
      steps: [],
    }
    this.currentStep = null
  }

  /** 记录一次 LLM 调用（一个 Step），后续 recordToolCall 挂到这个 Step 上 */
  recordStep(
    llm: {
      durationMs: number
      tokens?: StepTokens
      content: string
      finishReason: string
    },
    extra?: {
      /** 本次调用发出的历史消息（不含 system） */
      request?: TracedMessage[]
      /** 本轮 system 提示词（含 CLAUDE.md），首个 step 时存到 turn 上 */
      systemPrompt?: string
      /** 工具名列表，首个 step 时存到 turn 上 */
      toolNames?: string[]
    },
  ): void {
    if (!this.enabled || !this.current) return
    const step: StepTrace = {
      stepIndex: this.current.steps.length,
      llm,
      request: extra?.request,
      toolCalls: [],
    }
    this.current.steps.push(step)
    this.currentStep = step
    // system 提示词与工具在一轮内稳定，存一份即可
    if (extra?.systemPrompt && this.current.systemPrompt === undefined) {
      this.current.systemPrompt = extra.systemPrompt
    }
    if (extra?.toolNames && this.current.toolNames === undefined) {
      this.current.toolNames = extra.toolNames
    }
  }

  /** 记录当前 Step 触发的一次工具调用 */
  recordToolCall(info: {
    id: string
    name: string
    argumentsRaw: string
    durationMs: number
    resultContent: string
    isError: boolean
  }): void {
    if (!this.enabled || !this.currentStep) return
    let args: unknown
    try {
      args = JSON.parse(info.argumentsRaw || '{}')
    } catch {
      args = info.argumentsRaw
    }
    this.currentStep.toolCalls.push({
      id: info.id,
      name: info.name,
      arguments: args,
      durationMs: info.durationMs,
      resultPreview: info.resultContent.slice(0, RESULT_PREVIEW_CHARS),
      resultBytes: Buffer.byteLength(info.resultContent, 'utf-8'),
      isError: info.isError,
    })
  }

  /** 结束一轮：算耗时/汇总 token，追加 NDJSON 一行，重写 trace-data.js */
  endTurn(status: TurnStatus, errorMessage?: string): void {
    if (!this.enabled || !this.current) return
    const turn = this.current
    turn.durationMs = Date.now() - turn.startedAt
    turn.status = status
    if (errorMessage) turn.errorMessage = errorMessage
    turn.tokens = sumTurnTokens(turn)

    this.allTurns.push(turn)
    try {
      appendFileSync(NDJSON_PATH, JSON.stringify(turn) + '\n')
      this.writeDataJs()
    } catch (e) {
      // trace 落盘失败不应影响主流程
      console.error(`[trace] 写入失败: ${(e as Error).message}`)
    }
    this.current = null
    this.currentStep = null
  }

  // 把已完成的所有轮派生成 trace-data.js（viewer 以 <script src> 加载）。仅在 endTurn 后重写。
  private writeDataJs(): void {
    if (!this.enabled) return
    writeFileSync(
      DATA_JS_PATH,
      `window.__MCC_TRACE__=${JSON.stringify(this.allTurns)};\n`,
    )
  }

  /** viewer 路径，供启动时提示用户 */
  get viewerPath(): string {
    return VIEWER_PATH
  }
}
