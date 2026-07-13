# mcc — 第一步开发计划（grilling 定稿）

学习 + 开发项目：参考成熟 coding agent 的公开行为，做一个基础版 CLI agent，
一步步完善。

## 已定决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 语言/运行时 | TypeScript + Node.js + tsx，ESM |
| 2 | LLM 调用 | **裸 fetch** 手写 OpenAI 兼容协议（不用 openai SDK）；`apiKey` / `baseURL` / `model` 均可配置 |
| 3 | 流式 | 第一版**非流式**（`stream: false`），streaming 留作后续迭代 |
| 4 | 配置 | `~/.mcc/config.json`，启动读一次，缺失则报错并打印示例 |
| 5 | 终端 UI | `node:readline` 朴素 REPL；Ink 化留作后续专门一步 |
| 6 | Read 工具范围 | 文本读取核心行为完全对齐参考实现：绝对路径校验、不存在时相似文件名建议、`offset`/`limit`、默认 2000 行上限、`cat -n` 行号、超长行截断、空文件 system-reminder、工具描述文案 copy 自 `prompt.ts` |
| 7 | 图片/PDF/notebook | 第一版**全部实现**，允许加依赖。图片：base64 + `role:"user"` `image_url` 消息注入（OpenAI tool 消息不能带图，需视觉模型）；PDF：**完全对齐参考的 pdftoppm 路径**——所有 PDF 用 `pdftoppm`（poppler-utils，系统依赖）渲染为 100dpi JPEG，复用图片注入管线，支持 `pages` 参数、20 页/次上限、密码保护/损坏检测（copy 自 `src/utils/pdf.ts` 的 `extractPDFPages`）。注：小 PDF 走原生 `document` 块的路径依赖上游 API 能力，OpenAI 协议无此能力，不移植；notebook：JSON 解析拼文本 |
| 8 | 权限/缓存/analytics/skills | **日志桩**：保留调用位置，只打一行日志，不做真实现 |
| 9 | 工具抽象 | 裁剪版 `buildTool` 模式 + zod v4（`z.toJSONSchema()` 生成 OpenAI tools schema） |
| 10 | System prompt | 从参考项目裁剪改编（~30 行）：身份 + 简洁风格 + 工具使用规范 + 动态环境信息（cwd/平台/日期） |
| 11 | Agent 循环 | 工具自动执行（权限桩打 "auto-approved" 日志）；单输入内工具循环上限 20，超限警告并交还控制权；对话历史仅内存，退出即丢 |

## 目录骨架

```
mcc/
├── package.json          # name: mcc, bin: mcc
├── tsconfig.json
├── src/
│   ├── cli.ts            # 入口：读配置 → 启动 REPL
│   ├── config.ts         # 读 ~/.mcc/config.json
│   ├── repl.ts           # readline 循环
│   ├── query.ts          # agent 主循环（对话→tool call→回填）
│   ├── api.ts            # 裸 fetch 调 OpenAI 兼容接口
│   ├── prompts.ts        # system prompt + 环境信息拼装
│   ├── Tool.ts           # 工具抽象（裁剪自参考 src/Tool.ts）
│   ├── stubs.ts          # 权限/缓存/analytics/skills 日志桩
│   ├── tools/
│   │   └── FileReadTool/
│   │       ├── FileReadTool.ts   # 裁剪自参考 src/tools/FileReadTool/FileReadTool.ts（1183 行）
│   │       ├── prompt.ts         # 工具描述文案（copy 改写）
│   │       ├── imageReader.ts
│   │       ├── pdfReader.ts      # pdftoppm 渲染成 JPEG，裁剪自参考 src/utils/pdf.ts extractPDFPages
│   │       └── notebookReader.ts # 参考 src/utils/notebook.ts
│   └── utils/
│       └── file.ts       # addLineNumbers / findSimilarFile 等，copy 自参考 src/utils/file.ts
```

依赖：`zod`；系统依赖：poppler-utils（`brew install poppler`，提供 pdftoppm/pdfinfo）；开发依赖：`tsx`、`typescript`、`@types/node`。

## 参考项目关键文件索引

- `src/tools/FileReadTool/FileReadTool.ts` / `prompt.ts` / `limits.ts` — Read 工具本体
- `src/Tool.ts` — buildTool 工具抽象
- `src/utils/file.ts` — addLineNumbers、findSimilarFile
- `src/utils/notebook.ts` — ipynb 解析
- `src/utils/pdf.ts` — extractPDFPages（pdftoppm 渲染）、getPDFPageCount（pdfinfo）
- `src/utils/pdfUtils.ts` — parsePDFPageRange 等
- `src/utils/readFileInRange.ts` — 范围读取

## 后续迭代路线（未定稿，仅备忘）

streaming（SSE 解析）→ 更多工具（Bash/Edit/Write/Glob/Grep）→ 权限系统真实现 →
文件读取缓存 → Ink 终端 UI → 历史持久化/续聊
