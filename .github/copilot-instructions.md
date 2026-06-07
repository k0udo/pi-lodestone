# pi-lodestone development instructions

This repository builds persistent memory for the Pi coding agent and should remain local-LLM friendly by default.

## Front-of-mind constraints

- Optimize for local inference: bounded context, deterministic lexical retrieval, no default embeddings/model calls/network calls.
- Keep automatic injection cheap; heavy analysis belongs behind explicit slash commands or tools.
- Preserve user-message preamble injection as the default so the system prompt stays stable for prefix/KV-cache reuse.
- Treat the memory store as curated decisions/preferences/workflows, not a transcript or tool-output dump.
- Avoid read-path writes unless behind an opt-in environment variable.
- Preserve sanitization: strip `<private>...</private>` and mask common secret patterns before storage.

## Key files

- `extension/index.ts`: extension registration, tools, slash commands, injection, sanitization.
- `extension/scoring.ts`: tokenization and deterministic score logic.
- `extension/storage.ts`: JSONL store, locks, atomic writes, settings.
- `skills/lodestone/SKILL.md`: concise model-facing instructions.
- `skills/lodestone/README.md`: full operational reference.
- `docs/development.md`: maintainer notes and checklists.

## Validation

Run before proposing a commit:

```bash
npm test
npm pack --dry-run
```

If package contents change, confirm `package.json` `files` includes every shipped doc or runtime file needed by users.
