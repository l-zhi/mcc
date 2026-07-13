// 危险命令拦截，思路取自参考项目 src/tools/BashTool/destructiveCommandWarning.ts +
// bashSecurity.ts 的硬拦截精神，但大幅收敛为一份「灾难性、不可恢复」的黑名单。
//
// 与参考项目的差异：
//   - 参考里 destructiveCommandWarning 只是「信息性提示」，真正的拦截在 2600 行的
//     bashPermissions/bashSecurity（AST 解析 + 权限规则 + 交互式确认）里。
//   - mini 没有交互式权限对话（readline REPL 一律自动放行），所以这里把「灾难性操作」
//     直接改成【提示 + 拒绝】：命中即不执行，把原因回给模型，也打印给用户看。
//   - 只拦「几乎一定是误操作、且无法撤销」的命令，避免误伤正常开发命令
//     （如 `git reset --hard`、删项目内文件都放行——那是合理工作流）。
//
// 注意：这是正则层面的启发式拦截，不做完整 shell AST 解析，无法防御刻意混淆
// （如变量拼接、base64 解码执行）。定位是「防手滑/防模型犯浑」，而非对抗恶意输入。

type DangerPattern = {
  pattern: RegExp
  reason: string
}

const DANGEROUS_PATTERNS: DangerPattern[] = [
  // fork bomb —— 耗尽进程/内存，拖垮整机
  {
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    reason: 'fork bomb：会耗尽系统进程资源、拖垮整机',
  },

  // rm 递归强删指向 根 / 家目录 / 全盘通配 —— 不可恢复
  // 用两个前瞻分别断言存在 -r 与 -f（任意顺序、可合并如 -rf/-fr，也含长选项
  // --recursive/--force），再要求删除目标是 / ~ /* $HOME 之一。
  {
    pattern:
      /\brm\b(?=[^\n|;&]*(\s-[a-zA-Z]*r|\s--recursive))(?=[^\n|;&]*(\s-[a-zA-Z]*f|\s--force))[^\n|;&]*\s(\/|~|\$HOME|\$\{HOME\})(\s|\/?\*|\/?\s*$)/,
    reason: '递归强制删除根目录/家目录：不可恢复的灾难性删除',
  },

  // 格式化文件系统
  {
    pattern: /\bmkfs(\.\w+)?\s+\/dev\//,
    reason: '格式化磁盘分区：会抹掉分区上的全部数据',
  },

  // dd 直写块设备 —— 覆盖整盘
  {
    pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|hd|nvme|disk|mmcblk|vd)[a-z0-9]*/,
    reason: 'dd 直接写入块设备：会覆盖整块磁盘',
  },

  // 重定向/覆盖写入块设备
  {
    pattern: />\s*\/dev\/(sd|hd|nvme|disk|mmcblk|vd)[a-z0-9]*/,
    reason: '向块设备写入：会破坏磁盘数据',
  },

  // 递归 chmod/chown 作用于 根 / 家目录 —— 破坏系统权限、极难修复
  {
    pattern:
      /\bch(mod|own)\b[^\n|;&]*\s-[a-zA-Z]*R[^\n|;&]*\s(\/|~|\$HOME)(\s|$)/,
    reason: '递归修改根目录/家目录权限或属主：会破坏系统、极难恢复',
  },
]

/**
 * 检查命令是否命中灾难性危险模式。
 * 命中返回原因字符串（用于提示 + 拒绝），否则返回 null。
 */
export function checkDangerousCommand(command: string): string | null {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return reason
    }
  }
  return null
}
