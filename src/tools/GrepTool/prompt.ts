// 工具描述文案，copy/改写自参考项目 src/tools/GrepTool/prompt.ts。
// 改动点：去掉 Agent 工具引用（mini 还没有子代理）；"NEVER 用 Bash 跑 grep/rg"
// 改为通用表述（mini 还没有 Bash 工具，但约束本身值得保留）。

export const GREP_TOOL_NAME = 'Grep'

export const DESCRIPTION = 'Search file contents with regular expressions.'

export const PROMPT = `A powerful search tool built on ripgrep

  Usage:
  - ALWAYS use ${GREP_TOOL_NAME} for search tasks. NEVER invoke \`grep\` or \`rg\` as a shell command. The ${GREP_TOOL_NAME} tool has been optimized for correct permissions and access.
  - Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
  - Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
  - Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
  - Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
  - Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\`
`
