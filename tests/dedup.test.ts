import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Decision } from "../extension/types.ts";
import { findPotentialDuplicate, overlapRatio, significantWords } from "../extension/dedup.ts";

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "m1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/project",
    project: "project",
    source: "manual",
    title: "Pi Memory staleness review cadence",
    text: "Run stale memory review quarterly and keep it non destructive.",
    tags: [],
    important: false,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

test("significantWords drops short and stop words", () => {
  const words = significantWords("Pi memory staleness review cadence quarterly");
  assert(words.includes("staleness"));
  assert(words.includes("cadence"));
  assert(words.includes("quarterly"));
  assert(!words.includes("pi"));
  assert(!words.includes("memory"));
});

test("overlapRatio is symmetric over the smaller set and clamps empty input", () => {
  assert.equal(overlapRatio(["a", "b"], ["b", "c"]), 0.5);
  assert.equal(overlapRatio([], ["a"]), 0);
  assert.equal(overlapRatio(["a"], []), 0);
});

test("findPotentialDuplicate detects close lexical duplicates", () => {
  const base = makeDecision();
  const hit = findPotentialDuplicate("Memory staleness review cadence", "Review stale memories quarterly without deleting them.", [base]);
  assert.equal(hit?.decision.id, "m1");
});

test("findPotentialDuplicate skips unrelated memories", () => {
  const base = makeDecision();
  assert.equal(findPotentialDuplicate("Secret rotation policy", "Rotate API keys through the secrets CLI.", [base]), undefined);
});

test("findPotentialDuplicate ignores archived entries", () => {
  const archived = makeDecision({ archived: true });
  assert.equal(findPotentialDuplicate("Memory staleness review cadence", "Review stale memories quarterly.", [archived]), undefined);
});
