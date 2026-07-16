# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

### Added
- **多 Agent 协作 Phase 1–4**：
  - Phase 1 — Agent 工具：派发子代理，用全新上下文 + 受限工具集递归跑 `query()`，只回传最后一条 assistant 文本（上下文隔离）。护栏：排除 Agent（防递归）+ TodoWrite（不覆盖共享待办）
  - Phase 2 — 类型注册表（`src/agents/registry.ts`）：`general-purpose` / `explore`（只读），`subagent_type` 选择 + `whenToUse` 喂给父模型路由；按类型过滤工具子集
  - Phase 3 — 并行子代理：一条消息里多个 Agent 调用限流并发（`isConcurrencySafe` + `mapBounded`，上限 5）
  - Phase 4 — 观测性：子代理活动按递归深度缩进嵌套显示在终端（含并行）。（trace-viewer 的嵌套 sidechain 待后续：子代理暂用静默 tracer）
- `-d` / `--dir <path>` 启动参数：在指定代码库里启动（不传则用当前目录）。启动时 `process.chdir` 到目标目录，系统提示词/记忆/工具/trace 全部随之生效

### Changed
- `query()` 参数化：新增 `tools`（本轮工具集，默认全量）与 `depth`（递归深度）；`ToolContext` 透传 `config`/`confirm`/`depth`，为子代理起子循环提供地基

## [0.1.0] - 2026-07-13

### Added
- 权限 allowlist：确认对话新增「总是允许」，规则持久化到 `~/.mcc/settings.json`（`permissions.allow`），`/permissions` 查看
- TodoWrite 逐步执行强化：工具结果附推进语；主循环周期性注入 `<system-reminder>`
- 系统提示词区分「改存量代码」与「从零构建」，后者引导多文件、逐文件 Write
- 开源脚手架：`.gitignore`、`CONTRIBUTING.md`、`ROADMAP.md`、`config.example.json`、`docs/` 结构
- CI：`.github/workflows/ci.yml`（typecheck + test）
- `npm test`：`tests/run-all.ts` 统一跑全部测试
- 英文 README（`README.en.md`）+ 架构图 + stub 说明

### Changed
- **项目定名 `mcc`**：统一包名、CLI 命令 `mcc`、环境变量前缀 `MCC_`、配置目录 `~/.mcc`
- 目录整理：`test-*.ts` → `tests/`；A/B 示例游戏 → `examples/tank-game/`；`PLAN.md` → `docs/design/decisions.md`
- `demo/` 撤出 git（本地保留，含版权 PDF 与 opencode 产物）；`project-overview.html` / `learning-plan.html` / `LEARNING_PLAN.md` 挑入 `docs/notes/`
- README 工具清单修正（六 → 九）

### Fixed
- `tests/test-context-payload.ts`：工具数硬编码 8 → 动态 `allTools.length`（原为 stale 断言）

### Notes
- 公开发布前需完成来源 scrub，见 `docs/design/PRE-RELEASE-CHECKLIST.md`
