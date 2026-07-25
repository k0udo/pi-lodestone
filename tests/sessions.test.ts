import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveSessionId, SessionStore, titleFromEntries } from "../extension/sessions.ts";
import type { ProjectSessionRecord } from "../extension/types.ts";

async function tempSessionStore(): Promise<{ store: SessionStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-sessions-"));
  return { store: new SessionStore({ path: join(dir, "sessions.jsonl") }), dir };
}

function session(overrides: Partial<ProjectSessionRecord> = {}): ProjectSessionRecord {
  return {
    id: "ses_1",
    projectId: "prj_a",
    cwd: "/repos/a",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    title: "Initial title",
    decisionIds: [],
    artifactPaths: [],
    ...overrides,
  };
}

test("deriveSessionId prefers session file and is stable", () => {
  assert.equal(deriveSessionId("/tmp/session.jsonl"), deriveSessionId("/tmp/session.jsonl"));
  assert.match(deriveSessionId("/tmp/session.jsonl"), /^ses_file_[a-f0-9]{16}$/);
});

test("deriveSessionId fallback is stable over first user prompt and cwd", () => {
  const entries = [{ type: "message", message: { role: "user", timestamp: 123, content: [{ type: "text", text: "Build the thing" }] } }];
  assert.equal(deriveSessionId(undefined, entries, "/repos/a"), deriveSessionId(undefined, entries, "/repos/a"));
  assert.notEqual(deriveSessionId(undefined, entries, "/repos/a"), deriveSessionId(undefined, entries, "/repos/b"));
});

test("titleFromEntries uses the latest user prompt", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "Old task" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "New task with more detail" }] } },
  ];
  assert.equal(titleFromEntries(entries), "New task with more detail");
});

test("upsert updates an existing session", async () => {
  const { store, dir } = await tempSessionStore();
  try {
    await store.upsert(session());
    await store.upsert(session({ title: "Updated", updatedAt: "2026-01-02T00:00:00.000Z" }));
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].title, "Updated");
    assert.equal(all[0].updatedAt, "2026-01-02T00:00:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recent filters by project and orders newest first", async () => {
  const { store, dir } = await tempSessionStore();
  try {
    await store.upsert(session({ id: "old", projectId: "prj_a", updatedAt: "2026-01-01T00:00:00.000Z" }));
    await store.upsert(session({ id: "other", projectId: "prj_b", updatedAt: "2026-01-03T00:00:00.000Z" }));
    await store.upsert(session({ id: "new", projectId: "prj_a", updatedAt: "2026-01-04T00:00:00.000Z" }));
    const recent = await store.recent("prj_a", 5);
    assert.deepEqual(recent.map((s) => s.id), ["new", "old"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
