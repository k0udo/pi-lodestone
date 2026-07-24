# Proposal: Projects (session-grouped memory windows)

Status: draft for review. No extension code or fixtures changed by this doc.

## Goal

Group sessions that belong to the same project so a new session starts with a
useful **window** of memory from prior sessions of that project — continuity that
does not depend on the new prompt lexically overlapping past work.

## Non-goals

- Not rebuilding project *scoping* of decisions — that already exists
  (`sameProjectScope`, `projectOnly`, locality bonuses in `scoreDecision`,
  `settings.disabledProjects`).
- Not embeddings, background model calls, or transcript dumps. Same local-first,
  bounded, deterministic constraints as the rest of lodestone.

## Decisions locked (from review)

1. **Project identity = manual, sticky.** `/project use <name>` sets the active
   project and persists it. Sessions inherit the last-active project until
   changed — not a per-session re-prompt. This matches Claude Code Projects and
   avoids the local model forgetting to set scope each session.
2. **Window content = open threads + pinned decisions**, for the active project,
   injected regardless of lexical overlap. Auto session recaps are **deferred**
   (see reshape below).

## Reshape (2026-07-04) — lean + escalation reuse

Stepping back against the actual goal (focused context + lighten an upper layer):

- The high-signal, low-cost primitives are **project identity + open threads +
  surfaced pins**. These tie sessions together without bloating context. Build
  these.
- The direct "lighten the upper layer" lever is feeding the project object **up**
  into `/escalate-prep` / `subagent` handoffs, not just down into local sessions.
  A pre-focused escalation packet is where the expensive model stops re-deriving
  project context. This is now a first-class deliverable.
- **Auto session recaps are deferred.** Recap quality is the entire hinge and the
  heuristic generators are crude; injecting mediocre recaps every session start is
  a mini transcript dump that fights lodestone's "every token earns its place"
  premise and can *regress* focus. Recaps ship only if an eval shows they add
  signal (see Test / eval plan). `sessions.jsonl` still exists to carry threads;
  the `recap` field is optional and unused until proven.

## Runtime review findings (2026-07-04)

Reviewed the actual `ExtensionAPI` surface via the 13 dotfiles extensions plus
lodestone. Three findings change the design:

### 1. No session id — and module state is NOT durable

Nothing in any extension reads a session identifier. `ctx` exposes `cwd`,
`model`, `ui`, `hasUI`, `sessionManager`; `sessionManager` exposes `getBranch()`
and `getEntries()`. No id/path field on `ctx`, on the `session_start` event, or
on `sessionManager`.

Critically, `discipline-refresh` derives its turn count from
`sessionManager.getEntries()` *"because the count comes from the session file,
not process state… works across -p -c invocations."* That means **each turn in
`pi -p -c` mode is a fresh process** — module-level variables reset every turn.

Consequence: the earlier "synthesize a session id in module state at
`session_start`" fallback is **dead** — it would mint a new session every turn.
Session identity must derive from the durable session file.

**Decided:** key each session record on `hash(firstEntry.timestamp +
firstUserPrompt)` from `getEntries()`, and **upsert** by that key (constant across
`-c` resumes of the same session file). No upstream dependency. Do not hold
session identity in module state anywhere.

### 2. Package name mismatch (fix regardless of this feature)

Every dotfiles extension imports `@mariozechner/pi-coding-agent`; lodestone's
`package.json` peerDep is `@earendil-works/pi-coding-agent`. The runtime resolves
the `@mariozechner` name. New modules must import the name the runtime actually
loads. Reconcile the peerDep before adding files that import it.

### 3. More lifecycle events than the wiki lists

`session_shutdown` (used by lmstudio to clear its poll timer), `model_select`,
and `before_provider_request` all exist. **Recap capture should move to
`session_shutdown` + explicit commands**, not `agent_end` — but treat shutdown
as opportunistic (uncertain it fires in one-shot `-p` mode), so `/handoff` and
`/project end` remain the reliable capture points.

## Data model

### `projects.json` (registry, new file next to `decisions.jsonl`)

```jsonc
{
  "activeProjectId": "prj_lodestone",     // sticky pointer
  "projects": [
    {
      "id": "prj_lodestone",
      "name": "pi-lodestone",
      "createdAt": "2026-07-04T...",
      "roots": ["/Users/.../repos/pi-lodestone"], // informational; used for hints, not required
      "archived": false
    }
  ]
}
```

Active project is a single sticky pointer. `roots` is advisory only (used to
suggest `/project use` when you `cd` into a known root) — identity stays manual.

### `sessions.jsonl` (append-only, new file)

One record per session, upserted on `session_shutdown` / `/handoff` / `/project
end`. Mirrors the `decisions.jsonl` storage discipline (append for new, full
rewrite for upsert, mtime cache, `withMutation` lock).

Record `id` is derived, not random: `ses_<hash(firstEntry.ts + firstUserPrompt)>`
(see finding 1). Capture **upserts** by this id so `-c` resumes update one record
instead of creating duplicates.

```jsonc
{
  "id": "ses_<derived>",
  "projectId": "prj_lodestone",
  "startedAt": "...",
  "endedAt": "...",
  "cwd": "/Users/.../repos/pi-lodestone",
  "recap": "1-3 sentence summary of what this session did",
  "openThreads": ["left off mid-refactor of scoring.ts", "eval fixture X still red"],
  "decisionIds": ["<id>", "..."]   // decisions created during this session
}
```

Recap/threads are produced by the existing `summarize-session` heuristics
(`compactTurnText`, `decisionStatementFromTurn`) — no model call required. Recap
generation stays a **cold-path** operation (on `/handoff`, or opt-in at
`agent_end`), never on the hot path.

### `Decision` (types.ts) — one additive field

Add `projectId?: string`. New decisions stamp the active project id. Absence =
legacy/global. `cwd`/`project` stay for back-compat and the existing lexical
locality bonuses; `projectId` becomes the authoritative grouping key when present.

## Resolution & active project

- `session_start`: read `projects.json`, set module-level `activeProjectId` from
  the sticky pointer. If a registered `root` prefixes `ctx.cwd` and differs from
  the active project, surface a non-blocking hint ("cwd looks like <name>; run
  `/project use <name>`") — never auto-switch.
- All new decisions and the session record stamp `activeProjectId`.

### Reconcile `disabledProjects`

`settings.disabledProjects` is currently **cwd-keyed** — a different notion of
"project" than the new manual `projectId`. Two disagreeing definitions will drift.
Plan: move disable to `projectId`-keyed (`settings.disabledProjectIds`), keep
reading the legacy cwd list for back-compat, and have `/project` write the new
key. `disable-current`/`enable-current` operate on the active project id.

## Status line (shipped ahead of the rest)

The "which project am I in" indicator is already live: `session_start` now calls
`ctx.ui.setStatus("pi-project", "▸ <name>")` (gated on `ctx.hasUI`), alongside the
existing `pi-memory → mem:on`. Today the name is `projectName(ctx.cwd)`; once the
registry lands, `/project use` updates the same status id to the active project's
name (mirroring how `model_select` updates `lmstudio-model`). Distinct status id,
so it does not collide with `pi-memory`.

## Injection: the memory window

New, additive to the existing lexical path in `before_agent_start`. Gated by
`projectEnabled` and a new `PI_PROJECT_WINDOW` env gate. Core window is threads +
pins only (recaps deferred):

```
## Project: <name> (verify)
Open threads:
- left off mid-refactor of scoring.ts
- eval fixture X still red
Pinned decisions:
- [id] ★ <title>
```

Budget rules (local-model first):

- Open threads capped at `PI_PROJECT_WINDOW_THREADS` total (default 5), newest first.
- Pinned = `important:true` decisions with matching `projectId`, cap 3.
- Whole window hard-capped at `PI_PROJECT_WINDOW_CHARS` (default ~500) and
  skipped entirely if the active project has no threads or pins.
- Placement reuses the existing `INJECT_PLACEMENT` (`user` preamble default) so
  the system prompt stays prefix-cache stable.
- Recaps, if later enabled, prepend a `Recent sessions:` block under the same
  char cap — only behind `PI_PROJECT_RECAPS=true` and only after the eval passes.

The lexical decision injection is unchanged and runs alongside. Dedup: if a
pinned decision is already surfaced by lexical retrieval, drop it from the pinned
block.

## Escalation reuse (the upper-layer win)

The same project object that feeds local injection is the right context payload to
feed **up** into escalation. This is the direct mechanism for "lighten the upper
layer" — the expensive model (`escalate-claude`/`escalate-codex`) or `subagent`
starts pre-focused instead of re-deriving project context or making the user
re-explain.

- Expose a `buildProjectPacket(projectId)` helper that returns the bounded window
  (open threads + pinned decisions [+ recaps once proven]) as plain markdown.
- `/escalate-prep` includes the active project's packet in the escalation bundle.
- `subagent` handoffs can request it the same way.
- Same budget/caps as the injection window, so the packet stays bounded.

This makes the project object a reusable context primitive consumed by two callers
(local session start + escalation), not a session-injection-only feature.

## Commands (`/project`)

New slash command, single-handler dispatch like `/memory`:

```
/project                      show active project + counts
/project list                 list registered projects
/project new <name>           create + switch
/project use <name|id>        switch active (sticky)
/project rename <id> <name>
/project archive <id>
/project window               preview the current injection window
/project end [--apply]        write/refresh this session's recap + threads
/project thread add <text>    add an open thread to current session
/project thread done <n>      close a thread
```

`/handoff` integration: on handoff, auto-run `/project end --apply` so the recap
is captured before context is dropped.

## Config (env vars, documented in skills/lodestone/README.md)

| Var | Default | Effect |
|---|---|---|
| `PI_PROJECT_WINDOW` | `true` | Enable the project window injection (threads + pins) |
| `PI_PROJECT_WINDOW_THREADS` | `5` | Open threads to inject |
| `PI_PROJECT_WINDOW_CHARS` | `500` | Hard char cap on the window block |
| `PI_PROJECT_RECAPS` | `false` | Enable recap generation + injection (gated on the recap eval; Phase 5) |
| `PI_PROJECT_RECAP_SESSIONS` | `3` | Recent session recaps to inject when recaps are enabled |

## Back-compat & migration

- All new files/fields are additive; existing stores work untouched.
- No `projectId` on a decision = current behavior (cwd-heuristic scoping).
- Optional one-time `/project adopt`: bucket existing decisions into projects by
  their `projectRoot(cwd)` and register those as projects. Dry-run by default,
  `--apply` to write. Mirrors the existing `migrate` ergonomics.

## Test / eval plan

- `tests/projects.test.ts`: registry CRUD, sticky pointer, resolution order,
  `projectId` stamping.
- `tests/window.test.ts`: window builder respects all caps, skips empty
  projects, dedups pinned vs lexical, deterministic ordering.
- Extend `tests/storage.test.ts` for `sessions.jsonl` (append, patch, lock).
- Injection fixtures: assert a fresh no-lexical-overlap prompt still receives the
  project window (threads + pins), and that a disabled project receives nothing.
- `buildProjectPacket()`: asserts caps, ordering, and that an empty project
  yields an empty packet (no escalation noise).
- Keep the eval-gated workflow: land only after guarding fixtures pass.

### Recap gate (prerequisite for Phase 5)

Recaps do not ship until an eval demonstrates net signal. Define it before
building recap generation, not after:

- A fixture set of prior-session transcripts + a next-session prompt.
- Metric: does injecting the recap window measurably improve the next turn
  (fewer redundant re-reads / re-derivations) vs. threads+pins alone — without
  regressing on unrelated prompts (no false-positive injection).
- If recaps don't beat threads+pins, they don't ship. Threads are the cheap,
  curated signal; recaps must earn their tokens.

## Phasing (reshaped)

1. **Identity.** Registry + `projectId` stamping + `/project new|use|list` +
   status line repoint to active project. `disabledProjects` reconciliation.
2. **Threads + pins.** `sessions.jsonl` (threads only) + `/project thread
   add|done` + `/project end`/`/handoff` upsert. Window injection of threads +
   surfaced pins behind `PI_PROJECT_WINDOW`.
3. **Escalation reuse.** `buildProjectPacket()` + `/escalate-prep` and `subagent`
   integration. This is the upper-layer payoff.
4. **Adopt migration + docs.** `/project adopt` to bucket existing decisions.
5. **Recaps (experiment, gated).** Only after the focus/escalation eval below
   shows recaps add signal. Behind `PI_PROJECT_RECAPS=false` by default.

Ship 1–3 behind `PI_PROJECT_WINDOW=false` until proven against fixtures.
```
