import type { Decision } from "./types.ts";

export const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "was", "were",
  "are", "not", "you", "your", "but", "all", "can", "into", "use", "using", "any",
  "what", "when", "where", "why", "how", "who", "did", "does", "their", "there",
]);

const GENERIC_INJECTION_TERMS = new Set([
  "decision", "decided", "preference", "workflow", "implementation", "manual", "important", "pinned",
]);

export type TokenWeights = ReadonlyMap<string, number>;

const OPERATIONAL_TITLE_RE = /^(read|ran|executed|wrote|edited|listed|searched|fetched|opened)\b/i;

export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9_./:-]{3,}/g) ?? [];
  return matches
    .map((token) => token.replace(/^[.:-]+|[.:-]+$/g, ""))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

export function projectRoot(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  const reposIndex = parts.findIndex((part) => part.toLowerCase() === "repos");
  if (reposIndex >= 0 && parts[reposIndex + 1]) return `/${parts.slice(0, reposIndex + 2).join("/")}`;
  return cwd;
}

export function projectName(cwd: string): string {
  return projectRoot(cwd).split("/").filter(Boolean).at(-1) ?? cwd;
}

export function sameProjectScope(a: string, b: string): boolean {
  return projectRoot(a) === projectRoot(b) || projectName(a) === projectName(b);
}

export function inferTags(title: string, text: string, existing: string[] = []): string[] {
  const result = new Set(existing.filter(Boolean));
  const body = `${title}\n${text}\n${existing.join(" ")}`.toLowerCase();
  if (/\b(decision|decided|choose|chose|use .+ because|architectural decision)\b/.test(body)) result.add("decision");
  if (/\b(preference|prefer|always|never|do not|don't|avoid|standing instruction)\b/.test(body)) result.add("preference");
  if (/\b(workflow|process|procedure|steps|runbook|playbook|command sequence)\b/.test(body)) result.add("workflow");
  if (/\b(bug|bugfix|fix|fixed|error|failed|failure|root cause|regression|traceback)\b/.test(body)) result.add("bugfix");
  if (/\b(implemented|added|updated|created|refactored|commit|committed|push|pushed|migration|phase)\b/.test(body)) result.add("implementation");
  return [...result].sort();
}

export function buildTokenWeights(decisions: Decision[]): Map<string, number> {
  const active = decisions.filter((d) => !d.archived);
  const docCount = active.length;
  const docFreq = new Map<string, number>();
  for (const decision of active) {
    const tokens = new Set([
      ...tokenize(decision.title),
      ...decision.tags.flatMap(tokenize),
      ...tokenize(decision.text),
    ]);
    for (const token of tokens) docFreq.set(token, (docFreq.get(token) ?? 0) + 1);
  }
  const weights = new Map<string, number>();
  if (docCount === 0) return weights;
  for (const [token, df] of docFreq) {
    // Tiny deterministic IDF-style weighting: common corpus terms are slightly
    // damped, rare terms get a capped boost. No embeddings or model calls.
    weights.set(token, 0.75 + Math.min(1.75, Math.log((docCount + 1) / (df + 1))));
  }
  return weights;
}

/**
 * Lightweight scoring tuned for a small, curated decision corpus and local-LLM use.
 *
 * `now` is injected so tests can pin the clock. Lexical overlap on title+tags+text is
 * the floor; zero overlap → score 0 so unrelated memories never inject. Bonuses cover
 * pinning, project locality, prior usage, and recency.
 */
export function scoreDecision(
  decision: Decision,
  query: string,
  cwd: string | undefined,
  options: { now?: number; forInjection?: boolean; tokenWeights?: TokenWeights } = {},
): number {
  if (decision.archived) return 0;
  if (options.forInjection && decision.supersededBy) return 0;
  const q = tokenize(query);
  if (q.length === 0) return 0;
  const titleTokens = new Set(tokenize(decision.title));
  const tagTokens = new Set(decision.tags.flatMap(tokenize));
  const bodyTokens = new Set(tokenize(decision.text));

  const allDecisionTokens = [...bodyTokens, ...titleTokens, ...tagTokens];
  let lexical = 0;
  let strongMatches = 0;
  let meaningfulMatches = 0;
  const weighted = (term: string, base: number) => base * (options.tokenWeights?.get(term) ?? 1);
  for (const term of q) {
    if (titleTokens.has(term)) {
      lexical += weighted(term, 6);
      strongMatches += 1;
      if (!GENERIC_INJECTION_TERMS.has(term)) meaningfulMatches += 1;
    } else if (tagTokens.has(term)) {
      lexical += weighted(term, 4);
      strongMatches += 1;
      if (!GENERIC_INJECTION_TERMS.has(term)) meaningfulMatches += 1;
    } else if (bodyTokens.has(term)) {
      lexical += weighted(term, 3);
      strongMatches += 1;
      if (!GENERIC_INJECTION_TERMS.has(term)) meaningfulMatches += 1;
    } else if (allDecisionTokens.some((token) => token.includes(term) || term.includes(token))) {
      lexical += weighted(term, 1);
    }
  }
  if (lexical === 0) return 0;

  // Auto-injection is paid every turn, so it should prefer clear multi-token
  // evidence. Manual search can still surface weaker one-token hints.
  if (options.forInjection && strongMatches < 2) return 0;
  if (options.forInjection && meaningfulMatches < 1) return 0;
  if (options.forInjection && q.length >= 5 && meaningfulMatches < 3) return 0;
  if (options.forInjection && decision.source === "turn") return 0;
  if (options.forInjection && decision.source !== "manual" && OPERATIONAL_TITLE_RE.test(decision.title)) return 0;
  if (
    options.forInjection &&
    decision.source !== "manual" &&
    !decision.tags.some((tag) => ["decision", "preference", "workflow"].includes(tag))
  ) return 0;

  if (options.forInjection && q.length > 8) {
    // Long prompts contain many incidental words. Damp broad lexical totals so a
    // verbose user request does not turn common terms into false-positive memory.
    lexical = Math.max(1, Math.round(lexical * Math.sqrt(8 / q.length)));
  }

  let score = lexical;
  if (cwd && decision.cwd === cwd) score += 6;
  else if (cwd && sameProjectScope(decision.cwd, cwd)) score += 4;
  else if (cwd && decision.project === projectName(cwd)) score += 2;

  if (decision.important) score += options.forInjection ? 4 : 8;
  if (decision.source === "manual") score += options.forInjection ? 2 : 4;
  if (decision.kbPath) score += 3;
  if (!options.forInjection) {
    score += Math.min(decision.retrievalCount, 6);
    score += Math.min(decision.injectionCount, 4);
    if (decision.supersededBy) score -= 4;
  }

  const now = options.now ?? Date.now();
  const ageDays = (now - Date.parse(decision.createdAt)) / 86_400_000;
  if (ageDays < 1) score += 2;
  else if (ageDays < 14) score += 1;
  else if (ageDays > 180) score -= 2;

  return Math.max(0, Math.round(score));
}
