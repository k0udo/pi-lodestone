import { strict as assert } from "node:assert";
import type { Decision } from "../extension/types.ts";

function makeBaseDecision(overrides?: Partial<Decision>): Decision {
  return {
    id: `test-${Date.now()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    cwd: "/tmp/test-project",
    project: "test-project",
    source: "manual" as const,
    title: "Test Decision",
    text: "This is a test decision for schema validation.",
    tags: [],
    important: false,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

function runTest(name: string, fn: () => void) {
  try {
    fn();
    console.log(`✔ ${name}`);
  } catch (error) {
    console.error(`✖ ${name}`);
    throw error;
  }
}

runTest("Decision schema - backward compatibility", () => {
  // Old-style decision (without new fields) should still be valid
  const oldStyle: Decision = {
    id: "old-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/test",
    project: "test",
    source: "manual",
    title: "Old Style",
    text: "Old style decision without new fields",
    tags: [],
    important: false,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
  };
  assert.equal(oldStyle.id, "old-1");
  assert.equal(oldStyle.scope, undefined);
});

runTest("Decision schema - new fields", () => {
  // Decision with all new fields
  const newStyle: Decision = makeBaseDecision({
    scope: "project",
    key: "my_project_preference",
    summary: "This is a compact summary of the decision",
    details: ["Detail 1", "Detail 2"],
    confidence: "high",
    freshness: "current",
    tags: ["preference", "project"],
  });

  assert.equal(newStyle.scope, "project");
  assert.equal(newStyle.key, "my_project_preference");
  assert.equal(newStyle.summary, "This is a compact summary of the decision");
  assert.deepEqual(newStyle.details, ["Detail 1", "Detail 2"]);
  assert.equal(newStyle.confidence, "high");
  assert.equal(newStyle.freshness, "current");
});

runTest("Decision schema - all scope values", () => {
  const scopes: Decision["scope"][] = [
    "global",
    "project",
    "repo",
    "host",
    "tool",
    "workflow",
    "model",
    "engagement",
  ];
  for (const scope of scopes) {
    const decision = makeBaseDecision({ scope });
    assert.equal(decision.scope, scope);
  }
});

runTest("Decision schema - confidence values", () => {
  const confidences: Decision["confidence"][] = ["high", "medium", "low"];
  for (const confidence of confidences) {
    const decision = makeBaseDecision({ confidence });
    assert.equal(decision.confidence, confidence);
  }
});

runTest("Decision schema - freshness values", () => {
  const freshesses: Decision["freshness"][] = ["current", "may_be_stale", "stale"];
  for (const freshness of freshesses) {
    const decision = makeBaseDecision({ freshness });
    assert.equal(decision.freshness, freshness);
  }
});

runTest("DecisionPatch - includes all new fields", () => {
  // Test that DecisionPatch can update new fields
  const decision = makeBaseDecision();
  const patch: Partial<Decision> = {
    scope: "workflow",
    key: "updated_key",
    summary: "Updated summary",
    details: ["New detail"],
    confidence: "medium",
    freshness: "may_be_stale",
  };

  const patched = { ...decision, ...patch };
  assert.equal(patched.scope, "workflow");
  assert.equal(patched.key, "updated_key");
  assert.equal(patched.summary, "Updated summary");
  assert.deepEqual(patched.details, ["New detail"]);
  assert.equal(patched.confidence, "medium");
  assert.equal(patched.freshness, "may_be_stale");
});

runTest("Decision schema - optional fields can be omitted", () => {
  const minimal: Decision = makeBaseDecision({
    // All new fields intentionally omitted
  });

  assert.equal(minimal.scope, undefined);
  assert.equal(minimal.key, undefined);
  assert.equal(minimal.summary, undefined);
  assert.equal(minimal.details, undefined);
  assert.equal(minimal.confidence, undefined);
  assert.equal(minimal.freshness, undefined);
});

runTest("Decision schema - details array can be empty", () => {
  const decision = makeBaseDecision({ details: [] });
  assert.deepEqual(decision.details, []);
});

runTest("Decision schema - key follows snake_case convention", () => {
  const decision = makeBaseDecision({ key: "my_project_preference" });
  assert.match(decision.key!, /^[a-z_]+$/);
});
