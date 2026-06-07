# Decision store

The store is a `DecisionStore` class in `extension/storage.ts` that manages `~/.pi/agent/memory/decisions.jsonl`.

## File format

One JSON object per line. No arrays, no JSONL arrays. Each line is a complete `Decision` record.

```json
{"id":"abc123","createdAt":"2026-06-06T12:00:00.000Z",...}
{"id":"def456","createdAt":"2026-06-06T13:00:00.000Z",...}
```

Corrupt lines are silently skipped on read. The store is append-only for new entries; patches and migrations rewrite the full file.

## DecisionStore API

```ts
class DecisionStore {
  // Ensure files exist; called before every operation.
  ensure(): Promise<void>;

  // Read all decisions (cached, mtime-invalidated).
  all(): Promise<Decision[]>;

  // Find a single decision by ID.
  byId(id: string): Promise<Decision | undefined>;

  // Append a new decision. True append — does not rewrite the file.
  add(decision: Decision): Promise<Decision>;

  // Replace a decision by ID. Rewrites the full file.
  patch(id: string, patch: DecisionPatch): Promise<Decision | undefined>;

  // Replace the entire store. Used by migration.
  replaceAll(decisions: Decision[]): Promise<void>;

  // Increment retrieval/injection counters (opt-in).
  bumpUse(ids: string[], usage: "retrieved" | "injected"): Promise<void>;

  // Read settings file.
  readSettings(): Promise<Settings>;

  // Write settings file.
  writeSettings(settings: Settings): Promise<void>;
}
```

## Concurrency model

The store uses an in-process mutation queue. All write operations (`add`, `patch`, `replaceAll`, `bumpUse`) go through `withMutation()`:

1. Acquire an OS-level lock via `mkdir` (the lock directory).
2. Run the mutation.
3. Release the lock via `rm -rf`.

Stale locks are detected by checking the lock directory's mtime against `lockStaleMs` (default 30 seconds).

This means concurrent processes are safe, but concurrent writes within the same process are serialized.

## Cache behavior

The store caches decisions in memory keyed by file mtime. When `all()` is called:

1. Check if the cache exists and the file mtime matches. If so, return cached data.
2. If mtime changed (foreign write), reload from disk.
3. If the file doesn't exist, create it and return empty.

This makes foreign writes (other Pi processes, manual edits, migration) automatically visible without polling.

## Atomic writes

`writeAtomic(path, content)` writes to a temp file first, then renames to the target. This prevents partial writes from corrupting the store if the process crashes mid-write.

## Settings file

A separate `settings.json` file stores project-level settings:

```json
{
  "disabledProjects": ["/repos/secret-project"]
}
```

Projects in this list are excluded from automatic injection. The list is keyed by exact `ctx.cwd` at the time of disable.

## Migration

Migration is a one-time operation (`/memory migrate`) that:

1. Reads legacy `observations.jsonl` and `index.json`.
2. Imports entries with durable tags or actual usage history.
3. Drops raw tool-output and untagged turn captures.
4. Renames legacy files with a timestamp suffix.

The migration function is in `extension/migrate.ts` and is not called automatically.

## Adding a new store operation

When adding a new operation to `DecisionStore`:

1. If it's a read-only operation, use the cache (`all()` or `byId()`).
2. If it writes, use `withMutation()` for locking.
3. If it modifies existing records, use `replaceAll()` (full rewrite).
4. If it creates new records, use `appendFile()` (true append).
5. Update the cache after writes — either by extending the cached array or reloading.
6. Add a test in `tests/storage.test.ts` covering the new behavior.
