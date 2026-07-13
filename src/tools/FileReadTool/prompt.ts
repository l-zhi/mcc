// 工具描述文案，copy/改写自参考项目 src/tools/FileReadTool/prompt.ts。
// 改动点：去掉 Bash 工具引用（mini 还没有 Bash）、PDF 段按 pdftoppm 路径改写。

export const FILE_READ_TOOL_NAME = 'Read'

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const MAX_LINES_TO_READ = 2000

export const PDF_MAX_PAGES_PER_READ = 20

/** 无 pages 参数时允许整本读取的页数上限（超过则要求提供 pages），对齐参考 PDF_AT_MENTION_INLINE_THRESHOLD */
export const PDF_INLINE_PAGE_THRESHOLD = 10

export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

export const OFFSET_INSTRUCTION_DEFAULT =
  "- You can optionally specify a line offset and limit (especially handy for long files), but it's recommended to read the whole file by not providing these parameters"

export const PROMPT = `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
- By default, it reads up to ${MAX_LINES_TO_READ} lines starting from the beginning of the file
${OFFSET_INSTRUCTION_DEFAULT}
${LINE_FORMAT_INSTRUCTION}
- This tool allows reading images (eg PNG, JPG, etc). When reading an image file the contents are presented visually (the image is attached to the conversation as a user message).
- This tool can read PDF files (.pdf): pages are rendered to images and attached to the conversation. For large PDFs (more than ${PDF_INLINE_PAGE_THRESHOLD} pages), you MUST provide the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
