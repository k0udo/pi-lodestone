# Architecture overview

This is a Pi coding agent extension that provides persistent, local-LLM-friendly memory. The extension registers tools, slash commands, and event hooks with the Pi core. It stores decisions in an append-only JSONL file and retrieves them with deterministic lexical scoring.

## Entry point

`extension/index.ts` is the Pi extension entry point. It:

1. Creates a `DecisionStore` backed by `~/.pi/agent/memory/decisions.jsonl`.
2. Registers three tools: `memory-search`, `memory-get`, `memory-add`.
3. Registers the `/memory` slash command with subcommands.
4. Subscribes to Pi event hooks: `session_start`, `before_agent_start`, `context`, `agent_end`.
5. Optionally enables automatic turn capture via `PI_MEMORY_AUTO_TURN_CAPTURE=true`.

## Data flow

```
user request
    │
    ▼
before_agent_start  ← compact prompt → search → inject top-K memories
    │
    ▼
context             ← prepend memories to latest user message (default)
    │
    ▼
agent_end           ← optional turn capture (opt-in)
    │
    ▼
tool call / slash   ← read/write decisions via DecisionStore
```

## Components

| File | Role |
|---|---|
| `extension/index.ts` | Extension registration, tools, slash commands, event hooks, sanitization |
| `extension/storage.ts` | `DecisionStore` — JSONL file, locking, atomic writes, mtime cache |
| `extension/scoring.ts` | Tokenization, project scoping, deterministic `scoreDecision` |
| `extension/injection-log.ts` | Append-only diagnostic logs for injection and tool usage |
| `extension/migrate.ts` | One-time migration from legacy `observations.jsonl` |
| `extension/types.ts` | Shared data model |

## Hot path vs cold path

**Hot path** — runs every turn or on every tool call. Must stay bounded:
- `before_agent_start` search and injection
- `context` preamble application
- `memory-search`, `memory-get`, `memory-add` tool execution

**Cold path** — slash commands, migration, git operations, session summaries. Can do heavier work:
- `/memory extract-decisions`, `/memory summarize-session`
- `/memory git checkpoint|push`
- `migrate`

## Storage model

The store is a single `decisions.jsonl` file, one JSON object per line. Each line is a `Decision` record. The store uses:

- **Append-only writes** for new decisions (single `appendFile`).
- **Full rewrite** for patch/archive/migration operations (atomic write).
- **File locking** via `mkdir` to prevent concurrent corruption.
- **mtime cache** — invalidates on foreign writes detected by file timestamp change.

## Environment variable gates

| Variable | Default | Effect |
|---|---|---|
| `PI_MEMORY_DIAGNOSTIC_LOGS` | `false` | Enable injection/tool usage logs |
| `PI_MEMORY_DIAGNOSTIC_PROMPT_PREVIEW` | `false` | Include prompt preview in injection logs |
| `PI_MEMORY_AUTO_TURN_CAPTURE` | `false` | Auto-capture decisions from session turns |
| `PI_MEMORY_UPDATE_USAGE_COUNTERS` | `false` | Write retrieval/injection counters to store |
| `PI_MEMORY_INJECT_PLACEMENT` | `user` | `user` (preamble on user message) or `system` (append to system prompt) |
| `PI_MEMORY_VAULT_DIR` | unset | Enable vault note export |

See `skills/lodestone/README.md` for the full variable catalog.
