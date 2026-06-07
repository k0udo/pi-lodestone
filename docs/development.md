# Development notes

pi-lodestone is persistent memory for Pi with local LLM operation as the default constraint. Future changes should preserve predictable retrieval, small context injection, and low hot-path overhead before adding features.

## Design priorities

1. **Local-LLM first**: avoid embeddings, background model calls, network calls, or large prompt payloads in default behavior.
2. **Curated memory, not transcripts**: durable decisions/preferences/workflows should be explicitly selected or carefully extracted; raw tool output and full conversations should stay out of automatic injection.
3. **Cheap automatic injection**: the `context` hook must remain fast and bounded. Prefer deterministic lexical scoring, short snippets, and low result counts.
4. **Stable system prompt**: default injection belongs on the latest user message (`PI_MEMORY_INJECT_PLACEMENT=user`) so local providers can reuse prefix/KV cache.
5. **Privacy by default**: keep `<private>...</private>` stripping and common secret masking on every write path; diagnostic logs and prompt previews are opt-in.
6. **No read-path writes by default**: retrieval/injection counters and diagnostic logs are opt-in because local workflows should not rewrite the store every turn.

## Repository map

- `extension/index.ts` — Pi extension entrypoint, tool registration, slash commands, context injection, sanitization, and optional vault/git helpers.
- `extension/storage.ts` — append-only JSONL decision store, file locking, atomic rewrites, settings, archive/patch helpers.
- `extension/scoring.ts` — tokenization, project scoping, deterministic score calculation, and auto-injection filters.
- `extension/injection-log.ts` — compact diagnostics for injection and tool usage decisions.
- `extension/migrate.ts` — one-time migration from legacy `observations.jsonl`/`index.json` stores.
- `extension/types.ts` — shared data model.
- `skills/lodestone/SKILL.md` — compact model-facing usage instructions.
- `skills/lodestone/README.md` — full operator reference and environment-variable catalog.
- `tests/` — Node test suite for storage, scoring, injection logs, and evaluation fixtures.

## Hot-path rules

Automatic injection happens often, so treat it as a constrained runtime path:

- Do not add filesystem writes to normal search/injection unless guarded by an opt-in environment variable.
- Do not add model calls, embedding generation, or remote services to default scoring.
- Keep search limits, snippet lengths, and output caps bounded by environment variables with conservative defaults.
- Prefer mtime-invalidated caches and append-only writes over full-store rewrites when creating new entries.
- If a feature needs heavier work, expose it as a slash command or explicit tool action instead of running it every turn.

## Scoring and injection checklist

When changing `extension/scoring.ts` or injection logic in `extension/index.ts`:

- Keep zero-overlap queries at score `0`.
- Keep auto-injection stricter than manual search.
- Require multi-token evidence for automatic injection; avoid letting generic terms like "decision" or "workflow" trigger memories alone.
- Preserve project-local boosts without making unrelated global memories leak into active context by default.
- Update `tests/scoring.test.ts` and, when useful, `tests/fixtures/eval.jsonl`.
- Check `/memory why` and `/memory why-stats` output remains useful for threshold tuning.

## Store and migration checklist

When changing storage or data shape:

- Maintain backward compatibility with existing JSONL entries when possible.
- Make migrations idempotent and non-destructive; rename legacy files rather than deleting them.
- Preserve sanitization before persistence.
- Keep lock acquisition stale-safe and atomic writes crash-safe.
- Add tests for corrupt lines, concurrent-ish mutation behavior, archive/active state changes, and settings persistence when touched.

## Reference docs

[`docs/wiki/`](../wiki/) — architecture, scoring, store, extension API, privacy.
Useful when modifying any of the core modules.

## Commands before review

```bash
npm test
npm pack --dry-run
```

Use `npm pack --dry-run` for package-readiness changes because Pi installs this as an npm package and only files listed in `package.json` `files` will ship.

## Release checklist

1. Confirm `README.md` and `skills/lodestone/README.md` describe the same behavior.
2. Run `npm test`.
3. Run `npm pack --dry-run` and inspect included files.
4. Verify `package.json` metadata (`pi.extensions`, `pi.skills`, repository, bugs, keywords, files).
5. Bump version only when intentionally preparing a release.
6. Commit with explicit paths; tag/publish/release only after explicit confirmation.
