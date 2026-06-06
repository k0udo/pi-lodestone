import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Decision } from "../extension/types.ts";
import { DecisionStore, defaultStoreConfig } from "../extension/storage.ts";

function decision(overrides: Partial<Decision> = {}): Decision {
  const now = "2026-05-27T12:00:00.000Z";
  return {
    id: "test-1",
    createdAt: now,
    updatedAt: now,
    cwd: "/repos/example",
    project: "example",
    source: "manual",
    title: "Test decision",
    text: "Body text",
    tags: ["decision"],
    important: false,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

async function tempStore(): Promise<{ store: DecisionStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-store-"));
  const store = new DecisionStore(defaultStoreConfig(dir));
  await store.ensure();
  return { store, dir };
}

test("add then all returns the decision", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision());
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "test-1");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("byId returns the matching decision", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision({ id: "a" }));
    await store.add(decision({ id: "b", title: "Other" }));
    const b = await store.byId("b");
    assert.equal(b?.title, "Other");
    assert.equal(await store.byId("missing"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("patch updates fields and bumps updatedAt", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision());
    const patched = await store.patch("test-1", { important: true });
    assert.equal(patched?.important, true);
    assert.notEqual(patched?.updatedAt, decision().updatedAt);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("bumpUse increments retrieval/injection counters", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision({ id: "a" }));
    await store.add(decision({ id: "b" }));
    await store.bumpUse(["a", "b"], "retrieved");
    await store.bumpUse(["a"], "injected");
    const a = await store.byId("a");
    const b = await store.byId("b");
    assert.equal(a?.retrievalCount, 1);
    assert.equal(a?.injectionCount, 1);
    assert.equal(b?.retrievalCount, 1);
    assert.equal(b?.injectionCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cache reloads when file mtime changes (foreign writes detected)", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision({ id: "a" }));
    assert.equal((await store.all()).length, 1);
    // Simulate a foreign writer appending a new decision.
    const cfg = defaultStoreConfig(dir);
    const foreign = decision({ id: "foreign", title: "Foreign" });
    // Wait briefly to ensure mtime is observably newer on slower filesystems.
    await new Promise((r) => setTimeout(r, 10));
    await writeFile(cfg.decisionsPath, `${JSON.stringify(decision({ id: "a" }))}\n${JSON.stringify(foreign)}\n`, "utf8");
    const all = await store.all();
    assert.equal(all.length, 2);
    assert.ok(all.some((d) => d.id === "foreign"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings round-trip preserves disabledProjects list", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.writeSettings({ disabledProjects: ["/repos/secret"] });
    const settings = await store.readSettings();
    assert.deepEqual(settings.disabledProjects, ["/repos/secret"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("replaceAll rewrites the entire store", async () => {
  const { store, dir } = await tempStore();
  try {
    await store.add(decision({ id: "a" }));
    await store.add(decision({ id: "b" }));
    await store.replaceAll([decision({ id: "c", title: "Only one left" })]);
    const all = await store.all();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, "c");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
