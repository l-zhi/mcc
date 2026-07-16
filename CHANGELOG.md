# Changelog

格式参考 [Keep a Changelog](https://keepachangelog.com/)。

## [Unreleased]

### Added
- **Agent 工具（多 Agent Phase 1）**：派发子代理，用全新上下文 + 受限工具集递归跑 `query()`，只回传最后一条 assistant 文本（上下文隔离）。护栏：子代理工具集排除 Agent（防递归）与 TodoWrite（避免覆盖共享待办）
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
