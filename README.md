# Lodestone

Persistent memory for the [Pi coding agent](https://pi.dev), tuned for local LLMs.

A lodestone is a naturally magnetized stone — the original persistent memory and
the heart of a compass. Lodestone keeps a small, curated set of **decisions,
preferences, and workflows** so they survive across sessions, and quietly points
the agent back to them when they're relevant.

It is intentionally small (low hundreds of entries) and cheap to inject, so it
stays practical on locally-hosted models where every token of context counts.

## Install

```bash
pi install npm:pi-lodestone
```

This registers the `lodestone` skill plus three tools — `memory-search`,
`memory-get`, `memory-add` — and a `/memory` slash command.

## What it does

- **Curated, not a transcript dump.** Stores durable decisions/preferences/workflows
  in a single append-only `~/.pi/agent/memory/decisions.jsonl`. No tool-result
  auto-capture, no per-turn git work — nothing on the hot path.
- **Context-aware injection.** Before a turn, relevant memories are added as a
  non-persistent preamble on the latest user message (keeping the system prompt
  stable for prefix-cache reuse). Generic instruction words are dropped, multi-token
  evidence is required, and long prompts are damped to avoid false positives.
- **Local-LLM first.** Lexical, deterministic scoring (no embeddings/model calls),
  small snippets, and tight token budgets keep retrieval fast and predictable.
- **Privacy guards.** `<private>…</private>` blocks are stripped before storage and
  common secret patterns (`Bearer …`, `sk-…`, `TOKEN=…`) are masked automatically.

## Tools

```text
memory-search(query, limit?, projectOnly?)   search active memory; returns IDs + snippets
memory-get(ids, maxChars?)                    fetch full bodies for selected IDs
memory-add(title, text, tags?, important?)    persist a durable decision
```

## Configuration

All behavior is environment-variable configurable (injection limits, score
thresholds, snippet sizes, store location, an optional Markdown-vault export, …).
See [`skills/lodestone/README.md`](skills/lodestone/README.md) for the full
operational reference, slash-command catalog, and environment-variable table.

## License

MIT — see [LICENSE](LICENSE).
