import type { Decision } from "./types.ts";
import { buildTokenWeights, projectName, sameProjectScope, scoreDecision, type TokenWeights } from "./scoring.ts";
import { excerpt } from "./text.ts";

export type MemoryContext = {
  id: string;
  title: string;
  project: string;
  why_relevant: string;
  scope: Decision["scope"];
  key?: string;
  summary: string;
  details?: string[];
  confidence?: Decision["confidence"];
  freshness?: Decision["freshness"];
  score: number;
};

export type RetrievalResult = {
  memory_context: MemoryContext[];
  warnings: string[];
  recommended_context_budget: "tiny" | "small" | "medium";
};

export type TaskType = "quick_command" | "code_edit" | "architecture" | "security" | "session_recovery";
export type RetrievalDetail = "concise" | "detailed";

export type RetrievalBudgets = {
  [key in TaskType]: { max_memories: number; max_tokens: number };
};

export const DEFAULT_BUDGETS: RetrievalBudgets = {
  quick_command: { max_memories: 2, max_tokens: 300 },
  code_edit: { max_memories: 5, max_tokens: 600 },
  architecture: { max_memories: 8, max_tokens: 900 },
  security: { max_memories: 8, max_tokens: 900 },
  session_recovery: { max_memories: 12, max_tokens: 1500 },
};

export function getBudgetForTaskType(taskType: TaskType): RetrievalBudgets[keyof RetrievalBudgets] {
  return DEFAULT_BUDGETS[taskType];
}

export function getRecommendedContextBudget(taskType: TaskType): "tiny" | "small" | "medium" {
  const budget = DEFAULT_BUDGETS[taskType];
  if (budget.max_memories <= 2) return "tiny";
  if (budget.max_memories <= 5) return "small";
  return "medium";
}

export type ScoringOptions = {
  now?: number;
  forInjection?: boolean;
  includeSuperseded?: boolean;
  tokenWeights?: TokenWeights;
};

export type RetrievalOptions = ScoringOptions & {
  minScore?: number;
  projectOnly?: boolean;
  includeArchived?: boolean;
  includeSuperseded?: boolean;
  maxMemories?: number;
  maxTokens?: number;
  detail?: RetrievalDetail;
};

export type RankedMemory = {
  decision: Decision;
  score: number;
};

function normalizeOptions(taskTypeOrOptions: TaskType | RetrievalOptions | undefined, options: RetrievalOptions): { taskType: TaskType; options: RetrievalOptions } {
  if (!taskTypeOrOptions) return { taskType: "code_edit", options };
  if (typeof taskTypeOrOptions === "string") return { taskType: taskTypeOrOptions, options };
  return { taskType: "code_edit", options: taskTypeOrOptions };
}

function decisionMatchesProject(decision: Decision, cwd: string | undefined) {
  if (!cwd) return true;
  return sameProjectScope(decision.cwd, cwd) || decision.project === projectName(cwd);
}

function candidateMemories(decisions: Decision[], cwd: string | undefined, options: RetrievalOptions) {
  return decisions
    .filter((d) => options.includeArchived || !d.archived)
    .filter((d) => options.includeSuperseded || !d.supersededBy)
    .filter((d) => !options.projectOnly || decisionMatchesProject(d, cwd));
}

// Shared scorer wrapper kept for callers/tests that want a memory-specific name.
export function scoreMemory(
  memory: Decision,
  query: string,
  cwd: string | undefined,
  options: ScoringOptions = {},
): number {
  if (memory.supersededBy && !options.includeSuperseded) return 0;
  return scoreDecision(memory, query, cwd, {
    now: options.now,
    forInjection: options.forInjection,
    tokenWeights: options.tokenWeights,
  });
}

export function rankMemoryMatches(
  decisions: Decision[],
  query: string,
  cwd: string | undefined,
  options: RetrievalOptions = {},
): RankedMemory[] {
  const candidates = candidateMemories(decisions, cwd, options);
  const tokenWeights = options.tokenWeights ?? buildTokenWeights(candidates);
  const minScore = options.minScore ?? 1;
  return candidates
    .map((decision) => ({ decision, score: scoreMemory(decision, query, cwd, { ...options, tokenWeights }) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score || Date.parse(b.decision.createdAt) - Date.parse(a.decision.createdAt));
}

export function rankMemories(
  decisions: Decision[],
  query: string,
  cwd: string | undefined,
  options: RetrievalOptions = {},
): Decision[] {
  return rankMemoryMatches(decisions, query, cwd, options).map((x) => x.decision);
}

function charsForBudget(maxTokens: number, selectedCount: number) {
  // Coarse local-LLM budget: ~4 chars/token, split across selected memories.
  return Math.max(80, Math.floor((maxTokens * 4) / Math.max(1, selectedCount)));
}

function summaryFor(decision: Decision, query: string, maxChars: number) {
  return decision.summary?.trim()
    ? excerpt(decision.summary, query, maxChars)
    : excerpt(decision.text, query, maxChars);
}

function detailsFor(decision: Decision, query: string, maxChars: number, detail: RetrievalDetail) {
  if (detail !== "detailed" || !decision.details?.length) return undefined;
  return decision.details.slice(0, 4).map((line) => excerpt(line, query, Math.max(80, Math.floor(maxChars / 2))));
}

function relevanceReason(item: RankedMemory, query: string) {
  const parts = [`score ${item.score}`];
  if (item.decision.important) parts.push("pinned");
  if (item.decision.confidence) parts.push(`${item.decision.confidence} confidence`);
  if (item.decision.freshness) parts.push(item.decision.freshness.replaceAll("_", " "));
  return `Matches "${query}" (${parts.join(", ")})`;
}

function buildWarnings(selected: RankedMemory[]) {
  const warnings: string[] = [];
  for (const { decision } of selected) {
    if (decision.freshness === "stale") warnings.push(`Memory [${decision.id}] is marked stale: ${decision.summary || decision.title}`);
    if (decision.conflictsWith?.length) warnings.push(`Memory [${decision.id}] conflicts with: ${decision.conflictsWith.join(", ")}`);
  }
  return warnings;
}

export function retrieveMemories(
  decisions: Decision[],
  query: string,
  cwd: string | undefined,
  taskTypeOrOptions: TaskType | RetrievalOptions = "code_edit",
  maybeOptions: RetrievalOptions = {},
): RetrievalResult {
  const { taskType, options } = normalizeOptions(taskTypeOrOptions, maybeOptions);
  const budget = DEFAULT_BUDGETS[taskType];
  const maxMemories = options.maxMemories ?? budget.max_memories;
  const maxTokens = options.maxTokens ?? budget.max_tokens;
  const ranked = rankMemoryMatches(decisions, query, cwd, options).slice(0, maxMemories);
  const maxChars = charsForBudget(maxTokens, ranked.length);
  const detail = options.detail ?? "concise";

  return {
    memory_context: ranked.map((item) => ({
      id: item.decision.id,
      title: item.decision.title,
      project: item.decision.project,
      why_relevant: relevanceReason(item, query),
      scope: item.decision.scope,
      key: item.decision.key,
      summary: summaryFor(item.decision, query, maxChars),
      details: detailsFor(item.decision, query, maxChars, detail),
      confidence: item.decision.confidence,
      freshness: item.decision.freshness,
      score: item.score,
    })),
    warnings: buildWarnings(ranked),
    recommended_context_budget: getRecommendedContextBudget(taskType),
  };
}

export function retrieveTopMemories(
  decisions: Decision[],
  query: string,
  cwd: string | undefined,
  maxMemories: number = 5,
): MemoryContext[] {
  return retrieveMemories(decisions, query, cwd, {
    maxMemories,
    maxTokens: DEFAULT_BUDGETS.code_edit.max_tokens,
  }).memory_context;
}
