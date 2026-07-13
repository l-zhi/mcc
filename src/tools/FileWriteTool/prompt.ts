// 工具描述文案，copy/改写自参考项目 src/tools/FileWriteTool/prompt.ts。
// 改动点：去掉 "Prefer the Edit tool" 一句（mini 还没有 Edit 工具）。
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export const FILE_WRITE_TOOL_NAME = 'Write'

export const DESCRIPTION = 'Write a file to the local filesystem.'

export const PROMPT = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the ${FILE_READ_TOOL_NAME} tool first to read the file's contents. This tool will fail if you did not read the file first.
- NEVER create documentation files (*.md) or README files unless explicitly requested by the User.
- Only use emojis if the user explicitly requests it. Avoid writing emojis to files unless asked.`
