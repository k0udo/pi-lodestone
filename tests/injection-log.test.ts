import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeInjectionStats, computeToolUsageStats, logInjection, logToolUsage, readRecentInjections, readRecentToolUsage, renderInjectionStats, renderInjections, renderToolUsageStats, type InjectionRecord } from "../extension/injection-log.ts";

function record(overrides: Partial<InjectionRecord> = {}): InjectionRecord {
  return {
    ts: "2026-05-26T00:00:00.000Z",
    cwd: "/repos/example",
    project: "example",
    promptPreview: "what did we decide about memory recovery?",
    promptCharCount: 42,
    results: [
      { id: "m1", title: "Decision: use git checkpoints", kind: "note", source: "manual", score: 31, snippetLength: 120 },
      { id: "m2", title: "Workflow recap", kind: "note", source: "manual", score: 22, snippetLength: 200 },
    ],
    minScore: 18,
    limit: 5,
    globalInject: false,
    ...overrides,
  };
}

test("readRecentInjections returns empty array when log absent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mem-inj-"));
  try {
    const records = await readRecentInjections(join(dir, "missing.jsonl"), 10);
    assert.deepEqual(records, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("logInjection appends and readRecentInjections returns last N", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mem-inj-"));
  const path = join(dir, "injections.jsonl");
  try {
    await logInjection(path, record({ ts: "2026-05-26T00:00:00.000Z" }));
    await logInjection(path, record({ ts: "2026-05-26T00:01:00.000Z" }));
    await logInjection(path, record({ ts: "2026-05-26T00:02:00.000Z" }));
    const all = await readRecentInjections(path, 10);
    assert.equal(all.length, 3);
    const tail = await readRecentInjections(path, 2);
    assert.equal(tail.length, 2);
    assert.equal(tail[0].ts, "2026-05-26T00:01:00.000Z");
    assert.equal(tail[1].ts, "2026-05-26T00:02:00.000Z");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readRecentInjections skips corrupt lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mem-inj-"));
  const path = join(dir, "injections.jsonl");
  try {
    await logInjection(path, record());
    const { writeFile, appendFile } = await import("node:fs/promises");
    await appendFile(path, "this is not json\n", "utf8");
    await logInjection(path, record({ ts: "2026-05-26T00:01:00.000Z" }));
    const all = await readRecentInjections(path, 10);
    assert.equal(all.length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderInjections is readable and references each injected id", () => {
  const rec = record();
  const text = renderInjections([rec]);
  assert.ok(text.includes("[m1]"));
  assert.ok(text.includes("[m2]"));
  assert.ok(text.includes("score 31"));
  assert.ok(text.includes("minScore 18"));
  assert.ok(text.includes("example"));
});

test("renderInjections handles empty input", () => {
  assert.equal(renderInjections([]), "No memory injections recorded yet.");
});

test("computeInjectionStats returns zeros for empty input", () => {
  const stats = computeInjectionStats([]);
  assert.equal(stats.count, 0);
  assert.equal(stats.topInjected.length, 0);
  assert.equal(renderInjectionStats(stats), "No memory injections recorded yet.");
});

test("computeInjectionStats aggregates counts, percentiles, and top ids", () => {
  const base = record();
  const recs: InjectionRecord[] = [
    { ...base, ts: "2026-05-26T00:00:00.000Z", results: [
      { id: "m1", title: "Decision", kind: "note", source: "manual", score: 31, snippetLength: 100 },
      { id: "m2", title: "Workflow", kind: "note", source: "manual", score: 22, snippetLength: 200 },
    ] },
    { ...base, ts: "2026-05-26T00:01:00.000Z", results: [
      { id: "m1", title: "Decision", kind: "note", source: "manual", score: 28, snippetLength: 100 },
      { id: "m3", title: "Note", kind: "note", source: "manual", score: 19, snippetLength: 150 },
      { id: "m4", title: "Extra", kind: "tool", source: "read", score: 19, snippetLength: 80 },
      { id: "m5", title: "Extra2", kind: "tool", source: "read", score: 19, snippetLength: 80 },
      { id: "m6", title: "Extra3", kind: "tool", source: "read", score: 19, snippetLength: 80 },
    ] },
    { ...base, ts: "2026-05-26T00:02:00.000Z", results: [
      { id: "m1", title: "Decision", kind: "note", source: "manual", score: 25, snippetLength: 100 },
    ] },
  ];
  const stats = computeInjectionStats(recs);
  assert.equal(stats.count, 3);
  assert.equal(stats.spanFrom, "2026-05-26T00:00:00.000Z");
  assert.equal(stats.spanTo, "2026-05-26T00:02:00.000Z");
  assert.equal(stats.topInjected[0].id, "m1", "m1 should be most-injected");
  assert.equal(stats.topInjected[0].count, 3);
  assert.equal(stats.topScoreMax, 31);
  assert.equal(stats.topScoreMin, 25);
  assert.ok(stats.hitLimitPct > 0, "second event hits limit=5");
  assert.ok(stats.estTokensPerTurn > 0);
});

test("renderInjectionStats flags threshold pressure when tail avg is near minScore", () => {
  const base = record();
  const recs: InjectionRecord[] = [
    { ...base, results: [{ id: "x", title: "t", kind: "note", source: "manual", score: 19, snippetLength: 100 }] },
    { ...base, results: [{ id: "y", title: "t", kind: "note", source: "manual", score: 18, snippetLength: 100 }] },
  ];
  const out = renderInjectionStats(computeInjectionStats(recs));
  assert.ok(out.includes("threshold is doing real work"));
});

test("tool usage logging and stats capture per-tool call counts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-mem-tool-"));
  const path = join(dir, "tool-usage.jsonl");
  try {
    await logToolUsage(path, { ts: "2026-05-26T00:00:00.000Z", tool: "memory-search", cwd: "/repo", project: "repo", resultCount: 3 });
    await logToolUsage(path, { ts: "2026-05-26T00:01:00.000Z", tool: "memory-get", cwd: "/repo", project: "repo", resultCount: 1 });
    await logToolUsage(path, { ts: "2026-05-26T00:02:00.000Z", tool: "memory-search", cwd: "/repo", project: "repo", resultCount: 2 });
    const records = await readRecentToolUsage(path, 10);
    const stats = computeToolUsageStats(records);
    assert.equal(stats.count, 3);
    assert.equal(stats.byTool[0].tool, "memory-search");
    assert.equal(stats.byTool[0].count, 2);
    const rendered = renderToolUsageStats(stats);
    assert.ok(rendered.includes("memory-search: 2 calls"));
    assert.ok(rendered.includes("memory-get: 1 calls"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

