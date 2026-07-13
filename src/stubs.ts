// 框架层挂点的日志桩。
// 参考项目中这四个子系统各自是完整模块，这里只保留调用位置 + 一行日志，
// 后续迭代逐个替换为真实现：
//   权限   → src/utils/permissions/（checkPermissions / deny rules / 用户确认）
//   缓存   → readFileState + fileReadCache（文件未变时返回 FILE_UNCHANGED_STUB 省 token）
//   埋点   → src/services/analytics/（logEvent）
//   skills → src/skills/loadSkillsDir.ts（读文件时自动发现并激活相关 skill）

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'

function stubLog(subsystem: string, message: string): void {
  console.log(`${DIM}[${subsystem}] ${message}${RESET}`)
}

/** 权限桩：参考 FileReadTool.checkPermissions，这里一律放行 */
export function checkPermissionStub(toolName: string, input: unknown): 'allow' {
  stubLog('permission', `${toolName} auto-approved（权限系统未实现）: ${JSON.stringify(input)}`)
  return 'allow'
}

/**
 * 读缓存去重桩：参考实现里同文件同范围且 mtime 未变 → 返回 FILE_UNCHANGED_STUB 省 token。
 * 注意 readFileState 本身已是真实现（src/readFileState.ts，Write 的先读后写依赖它），
 * 这里桩掉的只是"去重返回 stub"这一步。
 */
export function readFileStateStub(filePath: string): undefined {
  stubLog('cache', `读取去重未实现，直接读取 ${filePath}`)
  return undefined
}

/** 埋点桩：参考 logEvent('tengu_*', ...) */
export function logEventStub(event: string, data?: Record<string, unknown>): void {
  stubLog('analytics', `${event} ${data ? JSON.stringify(data) : ''}`)
}

/** skills 发现桩：参考 discoverSkillDirsForPaths / activateConditionalSkillsForPaths */
export function discoverSkillsStub(filePath: string): void {
  stubLog('skills', `skill 自动发现未实现，跳过 ${filePath}`)
}

/** IDE 联动桩：参考写文件后的 LSP didChange/didSave 通知与 VSCode diff 视图通知 */
export function notifyIdeStub(filePath: string): void {
  stubLog('ide', `LSP/VSCode 通知未实现，跳过 ${filePath}`)
}

/** 文件历史桩：参考 fileHistoryTrackEdit（写前备份原内容，支持 /rewind 回滚） */
export function fileHistoryStub(filePath: string): void {
  stubLog('history', `文件历史备份未实现，跳过 ${filePath}`)
}
