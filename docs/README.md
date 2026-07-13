# docs — 文档与学习站

这里既是项目文档，也是面向学习者的课程。未来通过 GitHub Pages（根目录设为 `docs/`）
发布成可在线浏览的学习站，别人无需 clone、浏览器打开即可学。

## 结构

```
docs/
├── README.md                 # 本文件
├── design/                   # 设计决策
│   ├── decisions.md          # 历史设计决策（原 PLAN.md）
│   └── PRE-RELEASE-CHECKLIST.md
├── write-tool-internals.md   # 已有：Write 工具剖析
├── course/                   # （待迁）系统课程 chapter-01…10
└── internals/                # （待迁）深度剖析：read/grep/bash-tool-internals、
                              #   context-and-memory、memory-architecture、
                              #   multi-agent-collaboration、agent-orchestration…
```

## 编排思路：机制原理 ↔ 最小实现 配对

每篇 `internals/` 讲「一个成熟 coding agent 大致怎么做」，紧跟一句「mcc 的对应实现见
`src/xxx.ts`」。读者读完原理再读几百行的 mcc 代码，落差就是学习点。

## 待办

课件（`*.html` + 分章课程）待整理迁入 `docs/`。
