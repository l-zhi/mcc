// Bash 执行核心，裁剪自参考项目 src/utils/Shell.ts + ShellCommand.ts + shell/bashProvider.ts（三者合计约 1200 行）。
// 保留的精髓：
//   - 每条命令新起一个 shell 进程（非常驻 shell）——shell 状态（变量/别名）不跨命令持久化
//   - 【工作目录持久化】命令尾部追加 `pwd -P > 临时文件`，跑完读回并 process.chdir，
//     从而 cd 效果对后续所有工具（都用 process.cwd()）生效（对齐参考 bashProvider 的 cwd 追踪）
//   - 保留命令自身退出码（末尾 exit $code，而非被 pwd 的退出码覆盖）
//   - 超时/中断用「杀进程组」递归清理子孙进程（detached 让 child 成为组长，kill(-pid)）
// 裁剪掉：env 快照、sandbox、PowerShell、Windows 路径转换、输出写文件 fd（TaskOutput）、
//        progress 轮询、后台任务化、size watchdog、tree-kill 依赖（改用进程组）。
import { spawn } from 'child_process'
import { existsSync, readFileSync, statSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000 // 2 分钟
export const MAX_TIMEOUT_MS = 10 * 60 * 1000 // 10 分钟

// 输出字符上限，防大命令（如 `find /`）灌爆上下文（对齐参考项目的输出截断精神）
const MAX_OUTPUT_CHARS = 30_000

export type ExecResult = {
  stdout: string
  stderr: string
  code: number
  /** 因超时或中断被杀 */
  interrupted: boolean
}

// 只认 bash/zsh（对齐参考 findSuitableShell 的支持范围），兜底 /bin/sh
function findShell(): string {
  const envShell = process.env.SHELL
  if (envShell && (envShell.includes('bash') || envShell.includes('zsh'))) {
    return envShell
  }
  for (const p of ['/bin/bash', '/bin/zsh', '/bin/sh']) {
    if (existsSync(p)) return p
  }
  return '/bin/sh'
}

// 累加时即截断，避免 runaway 输出撑爆内存
function capOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return (
    s.slice(0, MAX_OUTPUT_CHARS) +
    `\n\n[output truncated at ${MAX_OUTPUT_CHARS} chars]`
  )
}

export async function execBash(
  command: string,
  options: { timeout?: number; signal?: AbortSignal } = {},
): Promise<ExecResult> {
  const timeout = Math.min(options.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
  const shell = findShell()

  const id = Math.floor(Math.random() * 0x10000)
    .toString(16)
    .padStart(4, '0')
  const cwdFile = join(tmpdir(), `ccm-${id}-cwd`)

  // 用户命令原样执行（保留管道/引号/heredoc/&& 等全部 shell 能力，无需转义），
  // 之后另起几行：存下命令退出码 → 落盘物理 cwd → 以命令退出码退出。
  const wrapped =
    `${command}\n` +
    `__ccm_code=$?\n` +
    `pwd -P > ${JSON.stringify(cwdFile)} 2>/dev/null\n` +
    `exit $__ccm_code`

  return new Promise<ExecResult>(resolve => {
    let stdout = ''
    let stderr = ''
    let interrupted = false
    let settled = false

    const child = spawn(shell, ['-c', wrapped], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        // 让 git 等不弹交互式编辑器；MCC=1 供子进程识别「运行在本 agent 内」
        GIT_EDITOR: 'true',
        MCC: '1',
      },
      // detached：child 成为进程组组长，超时时 kill(-pid) 可递归干掉子孙进程
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += d
    })
    child.stderr.on('data', (d: string) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += d
    })

    const killTree = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig)
      } catch {
        try {
          child.kill(sig)
        } catch {
          // 进程可能已退出
        }
      }
    }

    const timer = setTimeout(() => {
      interrupted = true
      killTree('SIGKILL')
    }, timeout)

    const onAbort = (): void => {
      interrupted = true
      killTree('SIGKILL')
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)

      // 读回命令结束后的物理 cwd，若发生变化则 process.chdir，
      // 使 cd 效果对后续所有工具（Grep/Read/Glob… 均用 process.cwd()）生效
      try {
        const newCwd = readFileSync(cwdFile, 'utf8').trim()
        if (
          newCwd &&
          newCwd !== process.cwd() &&
          statSync(newCwd).isDirectory()
        ) {
          process.chdir(newCwd)
        }
      } catch {
        // 命令异常退出可能没写成 cwd 文件，忽略即可
      }
      try {
        unlinkSync(cwdFile)
      } catch {
        // 文件可能不存在
      }

      let finalStderr = capOutput(stderr)
      if (interrupted) {
        const note = `Command timed out or was interrupted after ${Math.round(timeout / 1000)}s`
        finalStderr = finalStderr ? `${note}\n${finalStderr}` : note
      }
      resolve({
        stdout: capOutput(stdout),
        stderr: finalStderr,
        code,
        interrupted,
      })
    }

    // 用 'exit' 而非 'close'：不等孙进程 fd 关闭，shell 本体退出即返回（对齐参考注释）
    child.on('exit', (code, sig) => finish(code ?? (sig ? 137 : 1)))
    child.on('error', (err: Error) => {
      stderr += (stderr ? '\n' : '') + err.message
      finish(126) // Unix 执行错误约定码
    })
  })
}
