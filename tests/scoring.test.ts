import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Decision } from "../extension/types.ts";
import { buildTokenWeights, inferTags, projectName, projectRoot, sameProjectScope, scoreDecision, tokenize } from "../extension/scoring.ts";

const FROZEN = Date.parse("2026-02-01T00:00:00.000Z");
const FRESH = "2026-02-01T00:00:00.000Z";
const OLD = "2025-10-01T00:00:00.000Z";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "d",
    createdAt: FRESH,
    updatedAt: FRESH,
    cwd: "/repos/example",
    project: "example",
    source: "manual",
    title: "Decision",
    text: "We decided to use git checkpoints for memory recovery.",
    tags: ["decision"],
    important: false,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

test("tokenize splits on token chars, trims trailing punctuation, and drops stop words", () => {
  assert.deepEqual([...tokenize("the bug fix for memory recovery")].sort(), ["bug", "fix", "memory", "recovery"].sort());
  assert.deepEqual(tokenize("memory recovery."), ["memory", "recovery"]);
  assert.equal(tokenize("").length, 0);
});

test("projectRoot collapses nested repo paths to their project root", () => {
  assert.equal(projectRoot("/repos/example/macos/pi"), "/repos/example");
  assert.equal(projectName("/repos/example/macos/pi"), "example");
});

test("sameProjectScope matches by root or by name", () => {
  assert.equal(sameProjectScope("/repos/example/macos/pi", "/repos/example"), true);
  assert.equal(sameProjectScope("/repos/example", "/repos/other"), false);
});

test("inferTags adds intent tags from body text", () => {
  const tags = inferTags("Decision", "We decided to use git checkpoints.", []);
  assert.ok(tags.includes("decision"));
});

test("scoreDecision returns 0 when query has no token overlap", () => {
  const d = makeDecision({ title: "Other topic", text: "unrelated body", tags: [] });
  assert.equal(scoreDecision(d, "completely different query terms", "/repos/example", { now: FROZEN }), 0);
});

test("scoreDecision returns 0 for archived entries even with overlap", () => {
  const d = makeDecision({ archived: true });
  assert.equal(scoreDecision(d, "memory recovery checkpoints", "/repos/example", { now: FROZEN }), 0);
});

test("scoreDecision rewards title and tag matches above body matches", () => {
  const titleHit = makeDecision({ id: "t", title: "memory recovery checkpoints", text: "unrelated body content here", tags: [] });
  const bodyHit = makeDecision({ id: "b", title: "Unrelated topic", text: "memory recovery checkpoints here", tags: [] });
  const t = scoreDecision(titleHit, "memory recovery checkpoints", "/repos/example", { now: FROZEN });
  const b = scoreDecision(bodyHit, "memory recovery checkpoints", "/repos/example", { now: FROZEN });
  assert.ok(t > b, `title hit ${t} should beat body hit ${b}`);
});

test("scoreDecision boosts important and project locality", () => {
  const plain = makeDecision();
  const pinned = makeDecision({ id: "p", important: true });
  const cwd = "/repos/example";
  const q = "memory recovery checkpoints";
  assert.ok(
    scoreDecision(pinned, q, cwd, { now: FROZEN }) > scoreDecision(plain, q, cwd, { now: FROZEN }),
    "important pin should boost",
  );
});

test("scoreDecision excludes turn-source entries from automatic injection", () => {
  const manual = makeDecision({ id: "m", source: "manual" });
  const turn = makeDecision({ id: "t", source: "turn", important: true, tags: ["decision", "workflow", "turn"] });
  const cwd = "/repos/example";
  const q = "memory recovery checkpoints";
  assert.ok(scoreDecision(manual, q, cwd, { forInjection: true, now: FROZEN }) > 0);
  assert.equal(scoreDecision(turn, q, cwd, { forInjection: true, now: FROZEN }), 0);
});

test("scoreDecision requires multi-token evidence for automatic injection", () => {
  const singleTitleHit = makeDecision({ title: "Memory policy", text: "unrelated durable instructions live here", tags: [], important: true });
  const multiHit = makeDecision({ title: "Memory policy", text: "Recovery checkpoints protect the memory store.", tags: [], important: false });
  const cwd = "/repos/example";
  assert.equal(scoreDecision(singleTitleHit, "memory", cwd, { forInjection: true, now: FROZEN }), 0);
  assert.ok(scoreDecision(multiHit, "memory recovery", cwd, { forInjection: true, now: FROZEN }) > 0);
});

test("scoreDecision rejects generic durable tags as the only injection evidence", () => {
  const generic = makeDecision({ title: "Memory policy", text: "Keep concise durable memories.", tags: ["decision", "workflow"], important: true });
  const cwd = "/repos/example";
  assert.equal(scoreDecision(generic, "decision workflow", cwd, { forInjection: true, now: FROZEN }), 0);
});

test("scoreDecision excludes superseded entries from automatic injection", () => {
  const superseded = makeDecision({ supersededBy: "new", title: "Memory recovery checkpoints", text: "Use the old checkpoint workflow." });
  const cwd = "/repos/example";
  assert.equal(scoreDecision(superseded, "memory recovery checkpoints", cwd, { forInjection: true, now: FROZEN }), 0);
  assert.ok(scoreDecision(superseded, "memory recovery checkpoints", cwd, { now: FROZEN }) > 0);
});

test("buildTokenWeights gives rare tokens more influence than common corpus tokens", () => {
  const common = makeDecision({ id: "a", title: "Memory workflow", text: "common corpus token", tags: [] });
  const rare = makeDecision({ id: "b", title: "Memory opml", text: "common corpus token", tags: [] });
  const weights = buildTokenWeights([common, rare]);
  assert.ok((weights.get("opml") ?? 0) > (weights.get("memory") ?? 0));
});

test("scoreDecision ignores usage feedback during automatic injection", () => {
  const plain = makeDecision({ retrievalCount: 0, injectionCount: 0 });
  const used = makeDecision({ id: "u", retrievalCount: 50, injectionCount: 50 });
  const cwd = "/repos/example";
  const q = "memory recovery checkpoints";
  assert.equal(
    scoreDecision(used, q, cwd, { forInjection: true, now: FROZEN }),
    scoreDecision(plain, q, cwd, { forInjection: true, now: FROZEN }),
  );
});

test("scoreDecision excludes non-manual operational memories from automatic injection", () => {
  const operational = makeDecision({
    source: "extracted",
    title: "Ran python session analysis",
    text: "memory recovery checkpoints appeared in tool logs",
    tags: ["bash", "implementation"],
  });
  const accidentalDurableTags = makeDecision({
    id: "read-file",
    source: "extracted",
    title: "Read src/example-tool/index.ts",
    text: "memory recovery checkpoints appeared in copied source code",
    tags: ["implementation", "preference", "workflow"],
  });
  const durable = makeDecision({
    id: "durable",
    source: "extracted",
    title: "Memory recovery workflow",
    text: "Decision workflow: use checkpoints for memory recovery.",
    tags: ["decision", "workflow"],
  });
  const cwd = "/repos/example";
  assert.equal(scoreDecision(operational, "memory recovery checkpoints", cwd, { forInjection: true, now: FROZEN }), 0);
  assert.equal(scoreDecision(accidentalDurableTags, "memory recovery checkpoints", cwd, { forInjection: true, now: FROZEN }), 0);
  assert.ok(scoreDecision(durable, "memory recovery checkpoints", cwd, { forInjection: true, now: FROZEN }) > 0);
});


test("scoreDecision requires broader evidence for long automatic-injection queries", () => {
  const broadLocal = makeDecision({
    title: "LM Studio local LLM tuning",
    text: "Local LLM tool guidance was updated.",
    tags: ["local-llm"],
  });
  const specificMemory = makeDecision({
    id: "specific",
    title: "Pi memory local LLM injection tuning",
    text: "Reduced snippets, telemetry, and false positives for concise local LLM memory injection.",
    tags: ["pi-memory"],
  });
  const cwd = "/repos/example";
  const q = "memory injection local llm snippets telemetry false positives concise";
  assert.equal(scoreDecision(broadLocal, q, cwd, { forInjection: true, now: FROZEN }), 0);
  assert.ok(scoreDecision(specificMemory, q, cwd, { forInjection: true, now: FROZEN }) > 0);
});

test("scoreDecision is deterministic under a frozen clock", () => {
  const d = makeDecision({ createdAt: OLD });
  const cwd = "/repos/example";
  const q = "memory recovery checkpoints";
  assert.equal(scoreDecision(d, q, cwd, { now: FROZEN }), scoreDecision(d, q, cwd, { now: FROZEN }));
});

test("scoreDecision rewards prior retrieval and injection usage", () => {
  const plain = makeDecision({ retrievalCount: 0, injectionCount: 0 });
  const used = makeDecision({ id: "u", retrievalCount: 4, injectionCount: 2 });
  const cwd = "/repos/example";
  const q = "memory recovery checkpoints";
  assert.ok(
    scoreDecision(used, q, cwd, { now: FROZEN }) > scoreDecision(plain, q, cwd, { now: FROZEN }),
  );
});
