# mcc

[中文](./README.md) · **English**

A minimal, learning-oriented coding CLI agent, built step by step by studying the
public behavior of mature coding agents. See design notes in
[docs/design/decisions.md](./docs/design/decisions.md) and the plan in [ROADMAP.md](./ROADMAP.md).

> ⚠️ A learning project; its design takes inspiration from the public behavior of
> mature coding agents.

Current capabilities: a chat loop over the OpenAI-compatible protocol (non-streaming)
plus nine tools — Read (text / image / PDF / notebook), Write, Edit, Grep, Glob,
NotebookEdit, Bash (with dangerous-command blocking), TodoWrite (with step-by-step
reinforcement), and LSP (real language servers over JSON-RPC: definition / references /
hover / symbols / call hierarchy, 9 operations).

## Architecture at a glance

```
user input
   │
   ▼
 repl.ts ──► query.ts  (agent loop, max 20 steps)
                │  1. send request ──► api.ts ──► OpenAI-compatible endpoint
                │  2. model returns tool_calls
                │  3. run tools ──► Tool.ts ──► tools/*
                │       Read Write Edit Grep Glob NotebookEdit Bash TodoWrite LSP
                │  4. feed results back as role:"tool" ──► loop until plain text
                ▼
     context compaction · dual memory · permission gate · trace (cross-cutting)
```

Suggested reading order: `cli.ts → repl.ts → query.ts → Tool.ts → tools/*`.

> **On "stubs"**: `src/stubs.ts` intentionally stubs out permission logging, read-cache
> dedup, analytics, skill discovery, and IDE notifications (log-only, no real behavior),
> each pointing at the reference location it stands in for. "Not implemented" messages are
> by design, not bugs.

## Requirements

- Node.js 22+
- poppler-utils for PDF reading: `brew install poppler`
- A vision-capable OpenAI-compatible model (for images / PDFs)
- A language server per language for the LSP tool (see the Chinese README)

## Configuration

Copy [config.example.json](./config.example.json) to `~/.mcc/config.json`
and fill in your `apiKey` / `baseURL` / `model`. `baseURL` can point at any
OpenAI-compatible endpoint (DeepSeek / Qwen / Kimi, etc.).

## Run

```bash
npm install
npm start          # or: npx tsx src/cli.ts
```

Type `exit` / `quit` or Ctrl+C to quit.

## Development

```bash
npm run typecheck
npm test           # runs everything under tests/
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for how to add a tool and the test conventions.
The Chinese [README.md](./README.md) has fuller detail on the trace viewer, LSP setup,
and permission rules.
