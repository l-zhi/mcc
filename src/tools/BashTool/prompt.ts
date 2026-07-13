// 工具描述文案，裁剪自参考项目 src/tools/BashTool/prompt.ts 的 getSimplePrompt()（~370 行）。
// 保留：工具优先级引导（用 Read/Grep/Glob 而非 cat/grep/find）、并行 vs && 串行、
//      cwd 用绝对路径少用 cd、timeout 说明。
// 裁剪掉：sandbox section、undercover/ant 分支、git commit/PR 大段说明、embedded 搜索工具分支。
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from '../../utils/shell.js'

export const BASH_TOOL_NAME = 'Bash'

export const DESCRIPTION = 'Run shell command'

export const PROMPT = `Executes a given bash command and returns its output.

The working directory persists between commands (cd changes carry over), but shell state (variables, aliases) does not. Each command runs in a fresh shell.

IMPORTANT: Avoid using this tool to run \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` unless explicitly instructed or after you have verified a dedicated tool cannot do the job. Prefer the built-in tools — they give structured output, are token-efficient, and behave consistently across platforms:
- File search: use Glob (NOT find or ls)
- Content search: use Grep (NOT grep or rg)
- Read files: use Read (NOT cat/head/tail)
- Edit files: use Edit (NOT sed/awk)
- Write files: use Write (NOT echo >/cat <<EOF)
- Communication: output text directly (NOT echo/printf)

# Instructions
- If your command will create new directories or files, first run \`ls\` to verify the parent directory exists and is the correct location.
- Always quote file paths that contain spaces (e.g. cd "path with spaces/file.txt").
- Prefer absolute paths and avoid \`cd\` — try to keep your working directory stable. Use \`cd\` only if the user explicitly requests it.
- You may specify an optional timeout in milliseconds (up to ${MAX_TIMEOUT_MS}ms / ${MAX_TIMEOUT_MS / 60000} minutes). By default commands time out after ${DEFAULT_TIMEOUT_MS}ms (${DEFAULT_TIMEOUT_MS / 60000} minutes).
- When issuing multiple commands:
  - If independent, make multiple Bash tool calls in a single message so they run in parallel.
  - If they depend on each other, chain them in one call with '&&'.
  - Use ';' only when you want to run sequentially regardless of earlier failures.
  - Do NOT use newlines to separate commands (newlines are ok inside quoted strings).
- For git: prefer creating a new commit over amending; never use destructive operations (git reset --hard, git push --force, git clean -f) or skip hooks (--no-verify) unless the user explicitly asks.
- Do not use interactive flags (git rebase -i, git add -i) — interactive input is not supported.

# Safety
Some catastrophic, irreversible commands are blocked and will be rejected without running (e.g. \`rm -rf /\`, formatting disks, fork bombs). If a command is rejected for this reason, do NOT try to obfuscate or work around the block — explain the situation to the user instead.`
