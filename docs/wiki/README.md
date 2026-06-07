# Wiki

Reference docs for extending and evolving pi-lodestone. These are written for both humans and agents working on this codebase.

## Docs

- [Architecture overview](architecture.md) — how the pieces fit together, data flow, hot vs cold path.
- [Scoring model](scoring.md) — the deterministic lexical scoring function, filters, bonuses, and how to modify it.
- [Extension API](extension-api.md) — how tools, slash commands, and event hooks work; how to add new ones.
- [Decision store](store.md) — the JSONL store, locking, caching, atomic writes, and migration.
- [Privacy and security](privacy.md) — sanitization, secret masking, diagnostic logs, and what data is stored.

## Quick reference

| What you want to do | Start here |
|---|---|
| Understand how the extension works | [Architecture](architecture.md) |
| Change how memories are retrieved | [Scoring model](scoring.md) |
| Add a new tool or slash command | [Extension API](extension-api.md) |
| Change how decisions are stored | [Decision store](store.md) |
| Add sanitization or secret masking | [Privacy and security](privacy.md) |

## Conventions

- **Local-LLM first**: no embeddings, no model calls, no network calls in default behavior.
- **Bounded context**: short snippets, low result counts, environment-variable caps.
- **Append-only store**: new decisions use `appendFile`; patches use full rewrite.
- **Opt-in writes**: counters and diagnostics default to `false`.
- **Deterministic scoring**: lexical overlap + IDF weights + bonuses. No randomness.
- **Tests for behavioral changes**: scoring changes need `tests/scoring.test.ts` updates; store changes need `tests/storage.test.ts` updates.
