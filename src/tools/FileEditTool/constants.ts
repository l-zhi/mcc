// 单独成文件避免循环依赖（对齐参考 src/tools/FileEditTool/constants.ts）。
// FILE_UNEXPECTEDLY_MODIFIED_ERROR 之前临时放在 FileWriteTool.ts，
// Edit 工具落地后移到这里，Write / Edit 共用。
export const FILE_EDIT_TOOL_NAME = 'Edit'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified since it was last read, either by the user or by a linter. Read it again before attempting to write it.'
