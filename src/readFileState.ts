// 读文件状态表，对应参考项目 ToolUseContext.readFileState 的真实现（内存 Map）。
// 这是 Write（以及将来 Edit）"先读后写"安全机制的地基：
//   - Read 读完文本/notebook 后登记 {content, timestamp(mtime), offset, limit}
//   - Write 写之前查表：没读过 → 拒绝；磁盘 mtime 比登记时间新 → 拒绝（过期）
//   - Write 写完后回写新状态，使后续连续写不被自己拦截
// 参考项目还用它做 Read 去重（同文件同范围 mtime 未变返回 stub 省 token），
// 那部分仍是日志桩（见 stubs.ts readFileStateStub）。

export type FileReadEntry = {
  content: string
  /** 读取时文件的 mtime（毫秒，Math.floor 后） */
  timestamp: number
  offset: number | undefined
  limit: number | undefined
  /** 是否只读了文件的一部分（offset/limit 没覆盖全文件）——部分视图不允许直接整文件覆写 */
  isPartialView: boolean
}

const state = new Map<string, FileReadEntry>()

export const readFileState = {
  get(filePath: string): FileReadEntry | undefined {
    return state.get(filePath)
  },
  set(filePath: string, entry: FileReadEntry): void {
    state.set(filePath, entry)
  },
}
