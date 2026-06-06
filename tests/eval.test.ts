import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { Decision } from "../extension/types.ts";
import { buildTokenWeights, sameProjectScope, scoreDecision } from "../extension/scoring.ts";

type FixtureCase = {
  name: string;
  query: string;
  cwd: string;
  forInjection?: boolean;
  now: string;
  topK?: number;
  minScore?: number;
  projectOnly?: boolean;
  corpus: Decision[];
  expected_top_ids: string[];
  must_not_include?: string[];
};

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "eval.jsonl");

async function loadFixtures(): Promise<FixtureCase[]> {
  const raw = await readFile(FIXTURE_PATH, "utf8");
  return raw.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as FixtureCase);
}

function rank(c: FixtureCase): { id: string; score: number }[] {
  const now = Date.parse(c.now);
  const candidates = c.corpus
    .filter((d) => !d.archived)
    .filter((d) => !c.projectOnly || sameProjectScope(d.cwd, c.cwd));
  const tokenWeights = buildTokenWeights(candidates);
  return candidates
    .map((d) => ({ id: d.id, score: scoreDecision(d, c.query, c.cwd, { forInjection: c.forInjection ?? true, now, tokenWeights }) }))
    .filter((r) => r.score >= (c.minScore ?? 8)) // mirror real injection default min-score gate
    .sort((a, b) => b.score - a.score);
}

test("eval fixtures exist and are well-formed", async () => {
  const fixtures = await loadFixtures();
  assert.ok(fixtures.length > 0, "eval.jsonl must contain at least one case");
  for (const c of fixtures) {
    assert.ok(c.name, "fixture missing name");
    assert.ok(c.query, "fixture missing query");
    assert.ok(c.cwd, "fixture missing cwd");
    assert.ok(c.now, "fixture missing now");
    assert.ok(Array.isArray(c.corpus) && c.corpus.length > 0, "fixture corpus empty");
    assert.ok(Array.isArray(c.expected_top_ids), "fixture missing expected_top_ids");
  }
});

test("eval fixtures: every expected id appears in top-K (recall)", async () => {
  const fixtures = await loadFixtures();
  const failures: string[] = [];
  for (const c of fixtures) {
    const ranked = rank(c);
    const k = c.topK ?? 5;
    const topIds = new Set(ranked.slice(0, k).map((r) => r.id));
    for (const expected of c.expected_top_ids) {
      if (!topIds.has(expected)) {
        failures.push(`[${c.name}] expected '${expected}' in top-${k}; got: ${ranked.slice(0, k).map((r) => `${r.id}:${r.score}`).join(", ")}`);
      }
    }
  }
  assert.deepEqual(failures, [], `recall failures:\n${failures.join("\n")}`);
});

test("eval fixtures: must_not_include ids never appear in top-K (precision)", async () => {
  const fixtures = await loadFixtures();
  const failures: string[] = [];
  for (const c of fixtures) {
    const ranked = rank(c);
    const k = c.topK ?? 5;
    const topIds = new Set(ranked.slice(0, k).map((r) => r.id));
    for (const forbidden of c.must_not_include ?? []) {
      if (topIds.has(forbidden)) {
        failures.push(`[${c.name}] forbidden '${forbidden}' appeared in top-${k}`);
      }
    }
  }
  assert.deepEqual(failures, [], `precision failures:\n${failures.join("\n")}`);
});
