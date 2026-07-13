# Write 工具内部原理、调用链路与依赖

> 说明：对照一个成熟 coding agent 的 Write 工具行为整理
> mini 实现：`src/tools/FileWriteTool/FileWriteTool.ts`（~120 行）

## 一、定位

Write 是**整文件覆写**工具：给定绝对路径和完整内容，创建新文件或完全替换旧文件。
它和 Read 是一对：Read 在 `readFileState` 里登记"我读过什么、什么时候读的"，
Write 靠这份登记来保证**模型永远不会盲写它没看过的内容**。

## 二、核心原理：三道安全闸门

参考实现的全部复杂度几乎都围绕一个问题：**如何防止模型覆写掉它不知道的内容**。

### 闸门 1：先读后写（read-before-write）

```
文件存在于磁盘 && readFileState 里没有登记
  → "File has not been read yet. Read it first before writing to it."
```

模型必须先 Read 一次已存在的文件才能 Write 它。新建文件（磁盘上不存在）不受限。

### 闸门 2：部分视图拒绝（isPartialView）

Read 用了 `offset`/`limit` 只看了文件的一个片段（或文件超过 2000 行被默认上限截断）时，
登记会带上 `isPartialView: true`。这种登记**不算数**——只看过第 10~15 行就整文件覆写，
等于盲写其余部分。参考实现在 `validateInput` 里与闸门 1 用同一条错误拒绝。

### 闸门 3：过期检测（staleness），mtime 初筛 + 内容比对兜底

```
磁盘 mtime > 登记的读取时间戳
  → 初步判定"读后被外部修改过"（用户手改、linter 格式化……）
  → 但 mtime 会说谎：云同步、杀毒软件会只碰时间戳不改内容（Windows 上常见）
  → 兜底：全量读的场景直接比对当前磁盘内容与登记的 content
      内容一致 → 放行；不一致 → "File has been unexpectedly modified since it
      was last read... Read it again before attempting to write it."
```

参考实现把这个检测做了**两次**：`validateInput`（权限确认前，早失败）和 `call()` 内
写盘前（权限弹窗期间文件可能又变了）。第二次检测到真正写盘之间刻意**不安排任何
async 操作**，以保证"检查-写入"临界区不被并发编辑穿插——这是源码里专门写注释
强调的原子性约束。

### 写后回写：闭环的关键

写完立即 `readFileState.set(path, { content, timestamp: 新mtime, isPartialView: false })`。
两个作用：

1. 同一会话内**连续 Write 同一文件不会被自己拦截**（新 mtime 已登记）；
2. 之后的 Edit/Write 都以这份最新内容为基准。

### 一个有历史教训的细节：行尾处理

参考实现固定以 `LF` 写入、不改写模型给出的行尾。源码注释记录了教训：早期版本会
"保留旧文件的行尾风格"（新文件甚至用 ripgrep 采样仓库风格），结果在 Linux 上覆写
CRLF 文件时把 `\r` 写进 bash 脚本导致脚本损坏。结论：**模型发的 content 就是它想
写的字节，不要自作聪明**。

## 三、调用链路

### 参考项目完整链路

```
agent 主循环收到 tool_use(Write)
  │
  ├─ backfillObservableInput()        # ~ / 相对路径展开成绝对路径（防 hook 白名单绕过）
  ├─ validateInput()                  # 无重 I/O 的早期校验
  │    ├─ checkTeamMemSecrets()          # 团队记忆文件秘钥扫描
  │    ├─ matchingRuleForInput(deny)     # 权限 deny 规则
  │    ├─ UNC 路径跳过                    # Windows 防 NTLM 凭据泄漏
  │    ├─ 闸门 1：readFileState 先读后写
  │    ├─ 闸门 2：isPartialView
  │    └─ 闸门 3：mtime 过期（第一次）
  ├─ checkPermissions()               # checkWritePermissionForTool → 可能弹用户确认
  │
  ├─ call()
  │    ├─ discoverSkillDirsForPaths / activateConditionalSkillsForPaths   # skills 自动发现
  │    ├─ diagnosticTracker.beforeFileEdited()                            # LSP 诊断基线
  │    ├─ fs.mkdir(dirname)                                               # 确保父目录
  │    ├─ fileHistoryTrackEdit()                                          # 写前备份（/rewind 回滚用）
  │    ├─ readFileSyncWithMetadata()      # 旧内容 + 编码探测
  │    ├─ 闸门 3（第二次，内容比对兜底）── 临界区开始，此后无 async ──
  │    ├─ writeTextContent(path, content, 编码, 'LF')   # 临时文件原子写 + fsync
  │    ├─ LSP didChange / didSave 通知    # 触发 TypeScript 等服务器重新诊断
  │    ├─ notifyVscodeFileUpdated()       # IDE diff 视图
  │    ├─ readFileState.set()             # 写后回写
  │    ├─ logEvent / logFileOperation     # 埋点
  │    └─ 构造 create|update 输出 + structuredPatch（UI 展示 diff 用）
  │
  └─ mapToolResultToToolResultBlockParam()
       # 给模型的 tool_result 只有一句话（create/update 文案），
       # diff 只给 UI 看，不进上下文——省 token 的关键设计
```

### mini 链路（对照）

```
query.ts 主循环收到 tool_calls(Write)
  ├─ checkPermissionStub()            # 权限 → 日志桩
  ├─ zod inputSchema.safeParse()      # 参数校验（失败回给模型自纠）
  └─ FileWriteTool.call()
       ├─ expandPath()                     # ~ / 相对路径展开
       ├─ discoverSkillsStub()             # skills → 日志桩
       ├─ 闸门 1/2/3（合并在 call 内做一次；mini 无权限弹窗，两次检测无意义）
       ├─ fileHistoryStub()                # 文件历史 → 日志桩
       ├─ mkdir(dirname, recursive)
       ├─ writeFile(utf8)                  # 简化：无原子写/fsync/编码探测
       ├─ notifyIdeStub()                  # LSP/VSCode → 日志桩
       ├─ readFileState.set()              # 真实现，写后回写
       └─ 返回 create|update 文案（与参考逐字一致）
```

关键结构差异：参考项目把校验拆在 `validateInput`（权限确认**前**）和 `call`（权限确认
**后**）两处，因为权限弹窗期间文件可能变化；mini 没有权限交互，合并为一次。

## 四、依赖分析

### 参考实现的直接依赖（按职责分类）

| 类别 | 模块 | 作用 | mini 处理 |
|---|---|---|---|
| **状态** | `readFileState`（ToolUseContext） | 先读后写/过期检测的数据源 | ✅ **真实现**（`src/readFileState.ts`，内存 Map） |
| **文件 I/O** | `writeTextContent`（utils/file） | 临时文件原子写 + fsync + 编码/行尾控制 | ⚠️ 简化为 `writeFile(utf8)` |
| | `readFileSyncWithMetadata`（utils/fileRead） | 旧内容读取 + BOM/编码探测 | ⚠️ 简化为 `readFile(utf8)` |
| | `expandPath`（utils/path） | `~`/相对路径展开 | ✅ 已有简化版（utils/file.ts） |
| **安全** | `permissions/filesystem`（deny 规则、write 权限） | 权限系统 | 🔲 日志桩 |
| | `checkTeamMemSecrets` | 团队记忆秘钥扫描 | ❌ 未移植（niche） |
| | UNC 路径防护 | Windows NTLM 凭据泄漏 | ❌ 未移植（macOS 学习环境） |
| **IDE 联动** | `lsp/manager` + `LSPDiagnosticRegistry` | didChange/didSave 通知、诊断刷新 | 🔲 日志桩 |
| | `notifyVscodeFileUpdated` | VSCode diff 视图 | 🔲 日志桩 |
| | `diagnosticTracker` | 写前诊断基线（对比新增报错） | 🔲 日志桩（并入 ide 桩） |
| **回滚** | `fileHistory` | 写前备份，支持 /rewind | 🔲 日志桩 |
| **展示** | `utils/diff`（structuredPatch） | UI 里渲染 diff | ❌ 未移植（无 Ink UI） |
| | `utils/gitDiff` | 远程模式 git diff | ❌ 未移植 |
| **遥测** | `analytics`（logEvent 等） | 埋点 | 🔲 日志桩 |
| **框架** | `Tool.ts`（buildTool）、zod、skills | 工具抽象/校验/发现 | ✅ 已有裁剪版 |

### mini 内部依赖图

```
FileWriteTool.ts
  ├── readFileState.ts   ←──（同一份状态）──  FileReadTool.ts 读后登记
  ├── Tool.ts (buildTool)
  ├── stubs.ts (discoverSkills / fileHistory / notifyIde / logEvent)
  ├── utils/file.ts (expandPath)
  └── prompt.ts (工具描述，引用 FileReadTool 的工具名)
```

**Write 的引入把 Read 从"无状态工具"变成了"有副作用的登记者"**：Read 现在会把
`{content, mtime, offset, limit, isPartialView}` 写进 `readFileState`，这是两个工具
之间唯一的耦合点，也是将来 Edit 工具复用的同一套机制。

## 五、已验证行为（冒烟测试）

新建文件（含自动建父目录）✓ 未读先写拒绝 ✓ 读后写成功 ✓ 写后连续写 ✓
外部修改后写拒绝 ✓ mtime 变但内容未变放行 ✓ 部分读后整写拒绝 ✓ 全量读后可写 ✓
