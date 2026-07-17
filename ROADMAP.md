# Roadmap

mcc 是一个**边学边写**的项目：每个迭代实现一个完整 coding agent 的一块能力，
用 OpenAI 兼容协议从零搭。目标是让读者顺着迭代看懂一个 coding CLI
是怎么从「一个工具」长成「完整 agent」的。

> 建议：每完成一个迭代打一个 git tag（如 `v0.1-read`、`v0.2-write`），
> 学习者就能 `git checkout` 到任意阶段对照阅读。

## 已完成

| 能力 | 说明 |
|---|---|
| Agent 主循环 | 对话 → tool_calls → 执行 → 回填 → 循环（`src/query.ts`，上限 20 步） |
| Read 工具 | 文本 / 图片 / PDF(pdftoppm) / notebook |
| Write / Edit | 先读后写校验、过期检测 |
| Grep / Glob | ripgrep 封装 |
| NotebookEdit | .ipynb cell replace/insert/delete |
| Bash | 危险命令拦截（`dangerousCommands.ts`） |
| TodoWrite | 待办清单 + 逐步执行强化（结果推进语 + 周期性 system-reminder） |
| LSP | 真实语言服务器集成（spawn + JSON-RPC，9 种操作） |
| 上下文管理 | 字符估算 + microcompact(70%) / compact(85%) |
| 双记忆 | 分层 CLAUDE.md + agent 自管理记忆（MEMORY.md 索引） |
| 权限 allowlist | 一次性 y/N → 记住规则（`Bash(prefix:*)` / 工具级），持久化 settings.json |
| 链路 trace | NDJSON + 自包含 HTML viewer |
| 从零构建分文件 | 系统提示词引导多文件、逐文件 Write（对照 opencode 的 A/B 验证） |
| 多 Agent Phase 1–6 | Agent 工具（隔离）+ 类型注册表 + 并行 + 终端嵌套观测 + 异步后台（run_in_background / task-notification / TaskStop）+ SendMessage 进程内互通 |

## 待办（建议顺序）

1. **流式输出（SSE）** — `api.ts` 改流式，收益最大、改动集中
2. **多 Agent 收尾（选做）** — trace-viewer 子代理 sidechain 嵌套可视化
3. **历史持久化 / 续聊** — 对话落盘，可恢复 session
4. **Ink 终端 UI** — 替换 readline 朴素 REPL
5. **MCP / WebFetch / WebSearch** — 外部能力接入

## 开源前置

- [ ] LICENSE 选定
- [ ] 课件整理迁入 `docs/`
- [ ] secret 扫描
- [ ] GitHub Pages

## 待整理（技术债）

- `demo/`、`game/` 是多次会话攒下的实验产物，需筛选：保留有代表性的进 `examples/`，其余清理
- 剖析文档待整理迁入 `docs/internals/`
