# Architecture overview

This is a Pi coding agent extension that provides persistent, local-LLM-friendly memory. The extension registers tools, slash commands, and event hooks with the Pi core. It stores decisions in an append-only JSONL file and retrieves them with deterministic lexical scoring.

## Entry point

`extension/index.ts` is the Pi extension entry point. It is orchestration only —
tool/command/hook wiring — delegating helper logic to focused sibling modules. It:

1. Uses the shared `DecisionStore` singleton (`extension/store-instance.ts`) backed by `~/.pi/agent/memory/decisions.jsonl`.
2. Uses project/session stores backed by `projects.json` and `sessions.jsonl` for workspace context.
3. Registers memory tools: `memory-search`, `memory-get`, `memory-project-context`, `memory-add`.
4. Registers `/memory` and `/project` slash commands.
5. Subscribes to Pi event hooks: `session_start`, `before_agent_start`, `context`, `agent_end`, `session_shutdown`.
6. Optionally enables automatic turn capture via `PI_MEMORY_AUTO_TURN_CAPTURE=true`.

## Data flow

```
user request
    │
    ▼
before_agent_start  ← compact prompt → search → inject top-K memories
    │                 + optional bounded project packet (`PI_PROJECT_PACKET_INJECT=true`)
    ▼
context             ← prepend combined context to latest user message (default)
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
| `extension/index.ts` | Extension registration, tools, slash commands, event hooks (orchestration) |
| `extension/config.ts` | Environment-variable configuration resolved in one place |
| `extension/store-instance.ts` | Shared `DecisionStore` singleton |
| `extension/storage.ts` | `DecisionStore` — JSONL file, locking, atomic writes, mtime cache |
| `extension/projects.ts` | Sticky project registry for linked roots and context/artifact paths |
| `extension/project-dashboard.ts` | Testable `/project` dashboard rendering helpers |
| `extension/project-packet.ts` | Bounded project context packet builder; references paths only |
| `extension/sessions.ts` | Related-session index (`sessions.jsonl`) with titles/metadata, not transcripts |
| `extension/scoring.ts` | Tokenization, project scoping, deterministic `scoreDecision` |
| `extension/sanitize.ts` | `<private>` stripping and secret masking |
| `extension/text.ts` | Content extraction, truncation, query-aware excerpts, output caps |
| `extension/preamble.ts` | Inject memory block onto the latest user message |
| `extension/dedup.ts` | Lexical near-duplicate detection for `memory-add` |
| `extension/turn.ts` | Turn-capture helpers (durable-signal / decision-statement extraction) |
| `extension/git.ts` | Optional off-hot-path git checkpointing |
| `extension/vault.ts` | Optional Markdown-vault export |
| `extension/staleness.ts` | Review-only staleness analysis |
| `extension/injection-log.ts` | Append-only diagnostic logs for injection and tool usage |
| `extension/migrate.ts` | One-time migration from legacy `observations.jsonl` |
| `extension/types.ts` | Shared data model |

## Hot path vs cold path

**Hot path** — runs every turn or on every tool call. Must stay bounded:
- `before_agent_start` search and injection
- Optional project packet building when `PI_PROJECT_PACKET_INJECT=true`
- `context` preamble application
- `memory-search`, `memory-get`, `memory-project-context`, `memory-add` tool execution

**Cold path** — slash commands, migration, git operations, session summaries. Can do heavier work:
- `/memory extract-decisions`, `/memory summarize-session`
- `/memory git checkpoint|push`
- `migrate`

## Storage model

The primary store is `decisions.jsonl`, one JSON object per line. Each line is a `Decision` record. Lodestone also keeps a small `projects.json` registry and advisory `sessions.jsonl` related-session index. Session records store titles/metadata only — not transcripts. The decision store uses:

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
| `PI_PROJECT_PACKET_INJECT` | `false` | Opt-in: inject active project packet alongside memory context |
| `PI_PROJECT_PACKET_MAX_CHARS` | `1200` | Hard cap for injected project packet characters |
| `PI_MEMORY_VAULT_DIR` | unset | Enable vault note export |

See `skills/lodestone/README.md` for the full variable catalog.
