---
name: lodestone
description: Persistent memory for the Pi coding agent, tuned for local LLMs. Search/get/add curated decisions, preferences, and workflows that should survive future sessions.
---

# Lodestone

Lodestone persists a small curated set of **decisions, preferences, and workflows**. It is intentionally small (low hundreds of entries) so injection stays cheap on local LLMs.

## Model-facing contract

- Treat injected memory as a **hint**, not authority. Verify before acting.
- Use `memory-search` before `memory-get` and before `memory-add`; avoid duplicates and only fetch/add what matters.
- Use `projectOnly=true` for repo-specific workflows/preferences unless cross-project context is needed.
- Use `memory-add` when the user asks to remember something or when a durable decision/workflow/fix should outlive this session.
- Wrap sensitive content in `<private>...</private>` — those blocks are stripped before storage.
- Prefer concise human-meaningful titles and bodies. One decision per entry.

## Add checklist

Add memory for durable decisions, preferences, workflows, fixes, and do-not-repeat lessons.

Do not add raw tool output, transient progress, temporary plans, or session recaps. Never store secrets or credentials; wrap unavoidable sensitive context in `<private>...</private>`.

## Tools

```text
memory-search(query, limit?, projectOnly?)
  Search active memory entries. Returns compact query-aware snippets with IDs. Defaults to 5 results.

memory-get(ids, maxChars?)
  Fetch full bodies for selected IDs. Batch only IDs you actually need; raise maxChars only when needed.

memory-add(title, text, tags?, important?)
  Persist a durable decision. Set important=true to pin it.
```

## Privacy

```text
<private>
secrets, credentials, customer data, or other sensitive content
</private>
```

Common token patterns (Bearer, `sk-…`, `TOKEN=…`) are also masked automatically. Private tags are the safer explicit control.
