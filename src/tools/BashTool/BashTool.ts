// Bash 工具，裁剪自参考项目 src/tools/BashTool/BashTool.tsx（1144 行）。
// 保留：schema（command / timeout / description）、命令执行、退出码回报、输出组装。
// 新增（本项目需求）：危险命令拦截 —— 命中灾难性黑名单则【提示 + 拒绝】，不执行。
// 桩化/未移植：权限系统（query 层桩放行）、只读判定（恒 false，见下）、沙箱、后台任务、
//            progress 流式、sed 原地编辑特判、图片输出、git 操作追踪、UI 渲染。
import { z } from 'zod'
import { buildTool, type ToolResult } from '../../Tool.js'
import { logEventStub } from '../../stubs.js'
import { DEFAULT_TIMEOUT_MS, execBash, MAX_TIMEOUT_MS } from '../../utils/shell.js'
import { checkDangerousCommand } from './dangerousCommands.js'
import { BASH_TOOL_NAME, DESCRIPTION, PROMPT } from './prompt.js'

const DIM = '\x1b[2m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const inputSchema = z.object({
  command: z.string().describe('The command to execute'),
  timeout: z
    .number()
    .optional()
    .describe(`Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS})`),
  description: z
    .string()
    .optional()
    .describe(
      `Clear, concise description of what this command does in active voice (5-10 words). Examples:\n- ls → "List files in current directory"\n- git status → "Show working tree status"\n- npm install → "Install package dependencies"`,
    ),
})

export const BashTool = buildTool({
  name: BASH_TOOL_NAME,
  description: DESCRIPTION,
  prompt: PROMPT,
  inputSchema,
  // 第一版保守：Bash 一律视为非只读（能执行任意命令的黑盒）。
  // 参考项目用 1990 行的 readOnlyValidation 精确判定只读命令以便自动放行，
  // 那套白名单留作后续迭代（mini 目前也没有靠只读性做免确认的权限系统）。
  isReadOnly() {
    return false
  },
  async call({ command, timeout }, ctx): Promise<ToolResult> {
    // --- 危险命令拦截：提示 + 拒绝（本项目核心需求） ---
    const danger = checkDangerousCommand(command)
    if (danger) {
      // 提示：打印给用户看
      console.log(
        `${YELLOW}⚠ 已拒绝危险命令${RESET} ${DIM}${command}${RESET}\n  原因：${danger}`,
      )
      logEventStub('bash_command_blocked', { command, reason: danger })
      // 拒绝：抛错，由 query 层转成 isError 的工具结果回给模型（不执行）
      throw new Error(
        `该命令被拒绝执行（危险操作）：${danger}。这是不可恢复的操作，已被安全策略拦截。请勿尝试绕过；如确有需要，请让用户自行在终端手动执行。`,
      )
    }

    const result = await execBash(command, {
      timeout: timeout ?? DEFAULT_TIMEOUT_MS,
      // 透传中断信号：Ctrl+C 时 execBash 会杀掉整个进程组
      signal: ctx?.signal,
    })
    logEventStub('bash_command_executed', {
      exitCode: result.code,
      interrupted: result.interrupted,
    })

    // --- 输出组装（对齐参考 call 的收尾：stdout + stderr + 非零退出码） ---
    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(result.stderr)
    // 仅在真出错时附上退出码（对齐参考：0 与被中断不显式标注）
    if (result.code !== 0 && !result.interrupted) {
      parts.push(`Exit code ${result.code}`)
    }

    const content = parts.join('\n').trim()
    return { content: content || '(No output)' }
  },
})
