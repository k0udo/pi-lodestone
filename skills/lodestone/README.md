# Lodestone Operational Reference

Kept out of `SKILL.md` so local models don't pay tokens for the full operator catalog every turn.

## Architecture

Lodestone is intentionally minimal for local-LLM operation:

- **Single store**: `~/.pi/agent/memory/decisions.jsonl`. Append-only, in-process cached, mtime-invalidated on foreign writes.
- **Minimal lifecycle metadata**: `archived`, `important`, plus optional `supersededBy`/`supersedes`/`conflictsWith` for explicit human-reviewed corrections.
- **No tool-result auto-capture**: tool calls write no diagnostic usage logs unless `PI_MEMORY_DIAGNOSTIC_LOGS=true`. The local model never pays for a dedupe/append round-trip on every read/edit/bash call.
- **No agent_end auto-capture by default** (set `PI_MEMORY_AUTO_TURN_CAPTURE=true` to opt in).
- **No git work on the hot path**: checkpoint and push only on manual `/memory git checkpoint|push` or via a launchd backup job (see below).
- **One scoring function**: `scoreDecision`. Lexical hits in title/tags/body, plus tiny deterministic IDF-style corpus weighting, pin/locality/recency bonuses. Automatic injection first drops generic instruction words, requires multi-token non-generic evidence, damps long prompts, ignores usage-count feedback, excludes superseded entries and legacy `turn` captures, and excludes non-manual operational memories unless they carry durable decision/preference/workflow tags. When diagnostic logs are enabled, zero-result injection decisions are logged compactly for threshold tuning. Archived → score 0.
- **KV-cache-friendly injection**: by default, relevant memories are added as a non-persistent preamble on the latest user message via the `context` event, keeping the system prompt stable for local inference prefix-cache reuse. Set `PI_MEMORY_INJECT_PLACEMENT=system` only if provider behavior requires the old mutable-system-prompt mode.

## Slash commands

```text
/memory stats
/memory health
/memory self-test
/memory path
/memory search <query>
/memory recent [n]
/memory add <title> -- <body>
/memory archive <id...>
/memory active <id...>
/memory important <id...>
/memory unimportant <id...>
/memory promote-to-kb <id...> [--memory|--kb]
/memory extract-decisions [n] [--apply]
/memory summarize-session [--apply]
/memory why [n]
/memory why-stats [n]
/memory tool-stats [n]
/memory git status|init|checkpoint [msg]|push
/memory supersede <old-id> <new-id>
/memory conflict <id> <other-id...>
/memory disable-current
/memory enable-current
/memory migrate   # one-time import of legacy observations.jsonl
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_MEMORY_DIR` | `~/.pi/agent/memory` | Memory store directory |
| `PI_MEMORY_AUTO_INJECT` | `true` | Inject relevant memories before turns |
| `PI_MEMORY_AUTO_TURN_CAPTURE` | `false` | Opt-in: auto-capture turn decisions on agent_end |
| `PI_MEMORY_GLOBAL_AUTO_INJECT` | `false` | Allow cross-project automatic injection |
| `PI_MEMORY_INJECT_LIMIT` | `3` | Max memories injected per turn |
| `PI_MEMORY_INJECT_MIN_SCORE` | `8` | Minimum score for automatic injection |
| `PI_MEMORY_INJECT_SNIPPET_CHARS` | `180` | Max query-aware snippet characters per injected memory |
| `PI_MEMORY_INJECT_QUERY_MAX_TOKENS` | `32` | Max unique prompt tokens used for automatic injection search |
| `PI_MEMORY_INJECT_PLACEMENT` | `user` | `user` keeps system prompt stable by prefixing latest user message; `system` restores old system-prompt injection |
| `PI_MEMORY_SEARCH_DEFAULT_LIMIT` | `5` | Default `memory-search` and `/memory search` result count |
| `PI_MEMORY_SEARCH_SNIPPET_CHARS` | `220` | Max query-aware snippet characters per search result |
| `PI_MEMORY_GET_MAX_OUTPUT_CHARS` | `10000` | Default output cap for `memory-get`; pass `maxChars` for explicit expansion |
| `PI_MEMORY_UPDATE_USAGE_COUNTERS` | `false` | Opt-in: update retrieval/injection counters in `decisions.jsonl`; off by default to avoid read-path writes |
| `PI_MEMORY_DIAGNOSTIC_LOGS` | `false` | Opt-in: write injection/tool diagnostics to `injections.jsonl` and `tool-usage.jsonl` for `/memory why*` and `/memory tool-stats` |
| `PI_MEMORY_DIAGNOSTIC_PROMPT_PREVIEW` | `false` | Opt-in: include a short sanitized prompt preview in diagnostic injection logs |
| `PI_MEMORY_MAX_TEXT_CHARS` | `4000` | Max stored text per entry |
| `PI_MEMORY_TURN_USER_MAX_CHARS` | `1200` | Max user text retained when capturing turns |
| `PI_MEMORY_TURN_ASSISTANT_MAX_CHARS` | `1800` | Max assistant text retained when capturing turns |
| `PI_MEMORY_VAULT_DIR` | unset (disabled) | Set to a vault root to enable `promote-to-kb` |
| `PI_MEMORY_VAULT_MEMORY_DIR` | `Agent/Memory` | Vault-relative promotion folder for decisions/preferences |
| `PI_MEMORY_VAULT_KB_DIR` | `Agent/KB` | Vault-relative promotion folder for reference KB |
| `PI_SESSION_DIR` | `~/.pi/agent/sessions` | Session store (still managed by Pi core) |
| `PI_MEMORY_DEBUG` | unset | Log resolved store/session paths once at start |

## Backup as a scheduled job (recommended)

Lodestone never auto-pushes on the hot path. If you keep the store under git, run a
daily checkpoint+push out of band instead. On macOS, a launchd agent:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.example.lodestone-backup.plist
```

A minimal job that does `cd ~/.pi/agent/memory && git add -A && git commit -m 'daily' && git push` daily keeps a durable recovery point with zero per-turn cost. On Linux, a cron entry or systemd timer running the same commands works identically.

## Migration from legacy observations.jsonl

Run once after upgrading:

```text
/memory migrate
```

This:

1. Reads `~/.pi/agent/memory/observations.jsonl` + `index.json` if they exist.
2. Imports manual notes, promoted entries, and anything with `decision`/`preference`/`workflow`/`agent-kb`/`do-not-repeat`/`extracted-decision` tags, plus anything that's actually been retrieved or injected.
3. Drops raw tool-output and untagged turn captures (the volume that made the old store slow).
4. Renames the legacy files to `observations.jsonl.legacy-<ts>` and `index.json.legacy-<ts>` so nothing is destroyed.
