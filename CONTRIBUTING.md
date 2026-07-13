# 贡献指南

mcc 是一个学习项目，欢迎以「读懂 + 扩展一块能力」的方式参与。

## 本地运行

```bash
npm install
cp config.example.json ~/.mcc/config.json   # 填入你的 apiKey/baseURL/model
npm start                                                  # 或 npx tsx src/cli.ts
```

系统依赖：Node 22+；PDF 读取需 `brew install poppler`；LSP 需自装对应 language server。

## 代码结构

入口链路：`cli.ts → repl.ts → query.ts（主循环）→ Tool.ts → tools/*`。
建议按 [ROADMAP.md](./ROADMAP.md) 的「已完成」顺序读源码。

## 加一个新工具

1. 在 `src/tools/YourTool/` 下建 `YourTool.ts` + `prompt.ts`，用 `buildTool` 定义。
2. `isReadOnly()` 如实返回（只读工具自动放行；变更工具走权限门）。
3. 在 `src/query.ts` 的 `allTools` 注册。
4. 在 `src/prompts.ts` 的 Tool usage policy 段补一句用法（每加工具都要同步）。

## 测试约定

- 测试脚本在 `tests/`，用 `tsx` 直接跑（不进 `tsconfig` 的 src-only 编译）：
  `npx tsx tests/test-bash.ts`
- **改动 `src/utils/shell.ts` 或 `src/tools/BashTool/dangerousCommands.ts` 后，
  先跑 `npx tsx tests/test-bash.ts` 回归。**
- 提交前跑 `npm run typecheck`。

## 风格

跟随现有代码：中文注释，只在「WHY 不显然」处写注释，不做超出任务范围的重构。
