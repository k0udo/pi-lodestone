import { strict as assert } from "node:assert";
import type { Decision } from "../extension/types.ts";
import {
  retrieveMemories,
  retrieveTopMemories,
  rankMemories,
  scoreMemory,
  DEFAULT_BUDGETS,
  getBudgetForTaskType,
  getRecommendedContextBudget,
} from "../extension/retrieval.ts";
import { buildTokenWeights } from "../extension/scoring.ts";

function makeDecision(overrides?: Partial<Decision>): Decision {
  return {
    id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/tmp/test-project",
    project: "test-project",
    source: "manual" as const,
    title: "Test Memory",
    text: "This is a test memory for retrieval testing.",
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

runTest("budgets default values", () => {
  assert.equal(DEFAULT_BUDGETS.quick_command.max_memories, 2);
  assert.equal(DEFAULT_BUDGETS.code_edit.max_memories, 5);
  assert.equal(DEFAULT_BUDGETS.architecture.max_memories, 8);
  assert.equal(DEFAULT_BUDGETS.security.max_memories, 8);
  assert.equal(DEFAULT_BUDGETS.session_recovery.max_memories, 12);

  assert.equal(getBudgetForTaskType("quick_command").max_memories, 2);
  assert.equal(getBudgetForTaskType("code_edit").max_memories, 5);
});

runTest("getRecommendedContextBudget returns correct budget", () => {
  assert.equal(getRecommendedContextBudget("quick_command"), "tiny");
  assert.equal(getRecommendedContextBudget("code_edit"), "small");
  assert.equal(getRecommendedContextBudget("architecture"), "medium");
  assert.equal(getRecommendedContextBudget("security"), "medium");
  assert.equal(getRecommendedContextBudget("session_recovery"), "medium");
});

runTest("retrieveMemories returns memory_context array", () => {
  const decisions: Decision[] = [
    makeDecision({
      scope: "project",
      key: "preference_1",
      summary: "Use git for version control checkpointing",
      confidence: "high",
      freshness: "current",
    }),
  ];

  const result = retrieveMemories(decisions, "git version control", "/tmp/test-project");

  assert.ok(Array.isArray(result.memory_context));
  assert.equal(result.memory_context.length, 1);
  assert.equal(result.memory_context[0].scope, "project");
  assert.equal(result.memory_context[0].key, "preference_1");
  assert.ok(result.memory_context[0].summary.includes("git"));
});

runTest("retrieveMemories respects budget limit", () => {
  const decisions: Decision[] = Array.from({ length: 10 }).map((_, i) =>
    makeDecision({
      scope: "project",
      key: `mem_${i}`,
      summary: `Memory ${i}`,
    }),
  );

  const result = retrieveMemories(decisions, "memory", "/tmp/test-project", "quick_command");

  // quick_command has max_memories: 2
  assert.ok(result.memory_context.length <= 2);
});

runTest("retrieveMemories excludes archived entries", () => {
  const decisions: Decision[] = [
    makeDecision({ archived: false, summary: "Active memory" }),
    makeDecision({ archived: true, summary: "Archived memory" }),
  ];

  const result = retrieveMemories(decisions, "memory", "/tmp/test-project");

  assert.equal(result.memory_context.length, 1);
  assert.ok(result.memory_context[0].summary.includes("Active"));
});

runTest("retrieveMemories excludes superseded entries", () => {
  const decisions: Decision[] = [
    makeDecision({ summary: "Old memory", supersededBy: "new-id" }),
    makeDecision({ summary: "New memory" }),
  ];

  const result = retrieveMemories(decisions, "memory", "/tmp/test-project");

  assert.equal(result.memory_context.length, 1);
  assert.ok(result.memory_context[0].summary.includes("New"));
});

runTest("retrieveMemories generates warnings for stale memories", () => {
  const decisions: Decision[] = [
    makeDecision({
      summary: "Stale memory for version control",
      freshness: "stale",
    }),
  ];

  const result = retrieveMemories(decisions, "memory version", "/tmp/test-project");

  assert.ok(result.warnings?.some((w) => w.includes("stale")));
});

runTest("retrieveMemories generates warnings for conflicting memories", () => {
  const decisions: Decision[] = [
    makeDecision({
      summary: "Conflicting memory for version control",
      conflictsWith: ["other-id-1", "other-id-2"],
    }),
  ];

  const result = retrieveMemories(decisions, "memory version", "/tmp/test-project");

  assert.ok(result.warnings?.some((w) => w.includes("conflicts")));
});

runTest("rankMemories scores by relevance", () => {
  const decisions: Decision[] = [
    makeDecision({ title: "Use git for version control", text: "Version control with git is recommended" }),
    makeDecision({ title: "Use version control", text: "Always use version control for projects" }),
  ];

  const ranked = rankMemories(decisions, "git version", "/tmp/test-project");
  assert.ok(ranked.length === 2);
  // First should match "git" in title
  assert.ok(ranked[0].title.includes("git"));
});

runTest("scoreMemory returns 0 for archived decisions", () => {
  const decision = makeDecision({ archived: true });
  assert.equal(scoreMemory(decision, "test query", "/tmp/test-project"), 0);
});

runTest("scoreMemory returns 0 for superseded decisions", () => {
  const decision = makeDecision({ supersededBy: "new-id" });
  assert.equal(scoreMemory(decision, "test query", "/tmp/test-project"), 0);
});

runTest("scoreMemory rewards confidence score", () => {
  const decision = makeDecision({ summary: "Test decision for version control", confidence: "high" });
  const lowConfidence = makeDecision({ summary: "Test decision for version control", confidence: "low" });

  const highScore = scoreMemory(decision, "test version control", "/tmp/test-project");
  const lowScore = scoreMemory(lowConfidence, "test version control", "/tmp/test-project");

  assert.ok(highScore >= lowScore);
});

runTest("scoreMemory penalizes stale freshness", () => {
  const current = makeDecision({ summary: "Test decision for version control", freshness: "current" });
  const stale = makeDecision({ summary: "Test decision for version control", freshness: "stale" });

  const currentScore = scoreMemory(current, "test version control", "/tmp/test-project");
  const staleScore = scoreMemory(stale, "test version control", "/tmp/test-project");

  assert.ok(currentScore >= staleScore);
});

runTest("retrieveTopMemories limits to maxMemories", () => {
  const decisions: Decision[] = Array.from({ length: 10 }).map((_, i) =>
    makeDecision({ summary: `Memory ${i}` }),
  );

  const result = retrieveTopMemories(decisions, "memory", "/tmp/test-project", 3);
  assert.equal(result.length, 3);
});

runTest("retrieveTopMemories returns memory context format", () => {
  const decisions: Decision[] = [
    makeDecision({
      scope: "workflow",
      key: "my_workflow",
      summary: "Deploy using CI/CD pipeline for version control",
      confidence: "medium",
      freshness: "may_be_stale",
    }),
  ];

  const result = retrieveTopMemories(decisions, "deploy ci/cd version", "/tmp/test-project", 1);

  assert.equal(result.length, 1);
  assert.equal(result[0].scope, "workflow");
  assert.equal(result[0].key, "my_workflow");
  assert.ok(result[0].summary.includes("CI/CD"));
  assert.equal(result[0].confidence, "medium");
  assert.equal(result[0].freshness, "may_be_stale");
});

runTest("retrieveMemories handles empty decisions array", () => {
  const result = retrieveMemories([], "test query", "/tmp/test-project");
  assert.deepEqual(result.memory_context, []);
  assert.equal(result.warnings?.length, 0);
});

runTest("retrieveMemories returns warnings only when present", () => {
  const decisions: Decision[] = [makeDecision({ summary: "Clean memory" })];
  const result = retrieveMemories(decisions, "test", "/tmp/test-project");

  assert.deepEqual(result.warnings, []);
});

runTest("retrieveMemories rewards project scope match", () => {
  const sameProject = makeDecision({ cwd: "/tmp/test-project", summary: "Test decision for version control" });
  const differentProject = makeDecision({ cwd: "/tmp/other-project", summary: "Test decision for version control" });

  const sameScore = scoreMemory(sameProject, "test version control", "/tmp/test-project");
  const diffScore = scoreMemory(differentProject, "test version control", "/tmp/test-project");

  assert.ok(sameScore >= diffScore);
});

runTest("retrieveMemories with code_edit budget", () => {
  const decisions: Decision[] = Array.from({ length: 10 }).map((_, i) =>
    makeDecision({ summary: `Memory ${i}` }),
  );

  const result = retrieveMemories(decisions, "code", "/tmp/test-project", "code_edit");

  assert.ok(result.memory_context.length <= DEFAULT_BUDGETS.code_edit.max_memories);
});
