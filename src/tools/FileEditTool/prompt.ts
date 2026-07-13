// 工具描述文案，copy/改写自参考项目 src/tools/FileEditTool/prompt.ts。
// 改动点：去掉 isCompactLinePrefixEnabled feature flag（mini 固定用紧凑 `N\t` 行号）
//        与 USER_TYPE=ant 分支，其余逐字保留。
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const DESCRIPTION = 'A tool for editing files'

function getPreReadInstruction(): string {
  return `\n- You must use your \`${FILE_READ_TOOL_NAME}\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file. `
}

export const PROMPT = `Performs exact string replacements in files.

Usage:${getPreReadInstruction()}
- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: line number + tab. Everything after that is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`
