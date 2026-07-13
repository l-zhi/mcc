# Project memory

- 改动 shell.ts 或 dangerousCommands.ts 后，先跑 npx tsx tests/test-bash.ts 回归
- 测试脚本在 tests/（tsx 直接跑，不进 tsconfig 的 src-only 编译）
- 设计决策记录见 docs/design/decisions.md；迭代路线见 ROADMAP.md
