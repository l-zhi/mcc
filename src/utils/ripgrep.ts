// ripgrep 执行层，裁剪自参考项目 src/utils/ripgrep.ts（679 行）。
// 保留（容错语义的核心）：
//   - exit 0 = 有匹配、exit 1 = 无匹配，都是成功——rg 的 exit 1 不是错误
//   - ENOENT/EACCES/EPERM 抛给调用方（rg 本体坏了 ≠ 无匹配，静默返回空会误导模型）
//   - 超时/缓冲溢出：返回部分结果并丢弃最后一行（可能截断到一半）
//   - 超时且零结果：抛 RipgrepTimeoutError——让模型知道"没搜完"而不是"没搜到"
// 分发（对齐参考的 builtin/system 两种模式）：
//   - 默认 builtin：@vscode/ripgrep 包 vendor 的预编译二进制（参考项目 vendor 目录的等价物）
//   - USE_BUILTIN_RIPGREP=0 时用系统 rg
// 未移植：embedded 模式（argv0 分发）、EAGAIN 单线程重试、SIGTERM→SIGKILL
//        两级击杀、macOS 重签名、首次使用自检、流式变体 ripGrepStream。
import { execFile } from 'child_process'
import { createRequire } from 'module'

const MAX_BUFFER_SIZE = 20_000_000 // 20MB，大 monorepo 可能有 20 万+文件
const TIMEOUT_MS = 20_000

export class RipgrepTimeoutError extends Error {
  constructor(
    message: string,
    public readonly partialResults: string[],
  ) {
    super(message)
    this.name = 'RipgrepTimeoutError'
  }
}

let cachedRgPath: string | undefined

function getRgPath(): string {
  if (cachedRgPath) return cachedRgPath
  if (process.env.USE_BUILTIN_RIPGREP === '0') {
    // 对齐参考的安全细节：用命令名 'rg' 让 OS 解析，而不是绝对路径，防 PATH 劫持
    cachedRgPath = 'rg'
    return cachedRgPath
  }
  const require = createRequire(import.meta.url)
  const { rgPath } = require('@vscode/ripgrep') as { rgPath: string }
  cachedRgPath = rgPath
  return cachedRgPath
}

function splitLines(stdout: string): string[] {
  return stdout
    .trim()
    .split('\n')
    .map(line => line.replace(/\r$/, ''))
    .filter(Boolean)
}

export async function ripGrep(args: string[], target: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      getRgPath(),
      [...args, target],
      {
        maxBuffer: MAX_BUFFER_SIZE,
        timeout: TIMEOUT_MS,
        // SIGTERM 可能杀不死卡在不可中断 I/O 里的 rg，直接用 SIGKILL
        killSignal: 'SIGKILL',
      },
      (error, stdout) => {
        if (!error) {
          resolve(splitLines(stdout))
          return
        }

        // exit 1 是 rg 的正常"无匹配"
        if (error.code === 1) {
          resolve([])
          return
        }

        // rg 本体坏了（找不到/无权限执行），必须抛出而不是装作无匹配
        if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code as string)) {
          reject(
            new Error(
              `ripgrep failed to run (${error.code}). ` +
                (getRgPath() === 'rg'
                  ? 'System rg not found; install it (`brew install ripgrep`) or unset USE_BUILTIN_RIPGREP.'
                  : 'The bundled @vscode/ripgrep binary is missing; try reinstalling dependencies.'),
            ),
          )
          return
        }

        const isTimeout =
          error.signal === 'SIGTERM' || error.signal === 'SIGKILL'
        const isBufferOverflow =
          error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'

        let lines = splitLines(stdout ?? '')
        // 超时/溢出时最后一行可能被截断到一半，丢弃
        if (lines.length > 0 && (isTimeout || isBufferOverflow)) {
          lines = lines.slice(0, -1)
        }

        // 超时且拿不到任何结果：明确告诉模型"没搜完"，否则会被误读成"没匹配"
        if (isTimeout && lines.length === 0) {
          reject(
            new RipgrepTimeoutError(
              `Ripgrep search timed out after ${TIMEOUT_MS / 1000} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
              lines,
            ),
          )
          return
        }

        resolve(lines)
      },
    )
  })
}
