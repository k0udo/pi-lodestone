# Privacy and security

This extension handles user conversation data and stores it persistently. The default behavior is conservative: minimal writes, sanitization on every path, and opt-in diagnostics.

## Sanitization

Every write to the store goes through `sanitize(text)`:

```ts
function sanitize(text: string): string {
  return maskSecrets(stripPrivate(text)).trim().slice(0, MAX_TEXT_CHARS);
}
```

### Private block stripping

Content inside `<private>...</private>` tags is replaced with `[private omitted]`:

```
<private>Bearer sk-abc123</private>
→ [private omitted]
```

This is the primary privacy mechanism. Users should wrap sensitive content in these tags.

### Secret masking

Common secret patterns are masked before storage:

| Pattern | Replacement |
|---|---|
| `TOKEN=...`, `SECRET=...`, `API_KEY=...` | `TOKEN=[redacted]` |
| `Bearer <token>` | `Bearer [redacted]` |
| `sk-<20+ chars>` | `sk-[redacted]` |

### Character limits

- `PI_MEMORY_MAX_TEXT_CHARS` (default 4000): max stored text per entry.
- `PI_MEMORY_TURN_USER_MAX_CHARS` (default 1200): max user text in turn capture.
- `PI_MEMORY_TURN_ASSISTANT_MAX_CHARS` (default 1800): max assistant text in turn capture.

These limits prevent any single entry from consuming excessive disk or context.

## What is stored vs what is not

| Data | Stored? | Where |
|---|---|---|
| Manual decisions (via `memory-add`) | Yes | `decisions.jsonl` |
| Extracted decisions (`/memory extract-decisions --apply`) | Yes | `decisions.jsonl` |
| Turn capture (`PI_MEMORY_AUTO_TURN_CAPTURE`) | Yes | `decisions.jsonl` |
| Session summaries (`/memory summarize-session --apply`) | Yes, archived | `decisions.jsonl` |
| Retrieval/injection counters | No by default | `decisions.jsonl` (opt-in) |
| Injection diagnostics | No by default | `injections.jsonl` (opt-in) |
| Tool usage diagnostics | No by default | `tool-usage.jsonl` (opt-in) |
| Raw tool output | No | Not stored anywhere |
| Full conversation transcripts | No | Not stored anywhere |

## Diagnostic logs

Diagnostic logs are opt-in via `PI_MEMORY_DIAGNOSTIC_LOGS=false` (default). When enabled:

- `injections.jsonl`: records each injection event with query metadata and which memories were selected.
- `tool-usage.jsonl`: records each tool call with tool name and result count.

### Prompt previews

Prompt previews in injection logs are separately controlled by `PI_MEMORY_DIAGNOSTIC_PROMPT_PREVIEW=false` (default). When enabled, the first 200 characters of the sanitized prompt are stored.

These logs are append-only and never read by the injection system — they are only consumed by `/memory why*` and `/memory tool-stats` commands.

## Vault export

When `PI_MEMORY_VAULT_DIR` is set, decisions can be exported as Markdown notes in a vault directory. This is an explicit user action (`/memory promote-to-kb`) and does not happen automatically.

## Secret patterns not covered

The heuristic masking is intentionally narrow. It does not cover:

- Cookies and session tokens
- SSH keys
- OAuth refresh tokens
- DSNs (Sentry, etc.)
- URLs with embedded credentials
- Arbitrary PII

Users should use `<private>...</private>` tags for anything not covered by the built-in patterns.

## Adding new sanitization rules

To add a new secret pattern:

1. Add a new `.replace()` call in `maskSecrets()` in `extension/sanitize.ts`.
2. Use a specific regex — avoid overly broad patterns that might false-positive on normal text.
3. Test with `tests/` to ensure the pattern works as expected.
4. Document the new pattern in this file.

## Audit trail

The diagnostic logs (when enabled) provide an audit trail of:

- Which memories were injected when.
- Which tools were called and how many results they returned.
- How often each memory was retrieved or injected.

This data can help tune injection thresholds and detect unexpected behavior, but should not be enabled in workflows where even diagnostic metadata is sensitive.
