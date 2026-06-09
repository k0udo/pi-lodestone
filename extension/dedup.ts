import type { Decision } from "./types.ts";
import { tokenize } from "./scoring.ts";

// Lightweight lexical duplicate detection used to warn on near-identical adds.
// Deliberately deterministic and cheap — no embeddings, just significant-word
// overlap on title and the opening of the body.

const DEDUP_STOP_WORDS = new Set([
  "about", "after", "again", "agent", "because", "before", "current", "decision", "decided", "default", "during", "entry", "implementation", "memory", "pi", "project", "should", "summary", "that", "then", "there", "these", "this", "using", "when", "with", "workflow",
]);

export function significantWords(text: string): string[] {
  return [...new Set(tokenize(text).filter((token) => token.length >= 4 && !DEDUP_STOP_WORDS.has(token)))];
}

export function overlapRatio(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const shared = a.filter((token) => bSet.has(token)).length;
  return shared / Math.min(a.length, b.length);
}

export function findPotentialDuplicate(title: string, text: string, existing: Decision[], threshold = 0.6): { decision: Decision; score: number } | undefined {
  const newTitleWords = significantWords(title);
  const newBodyWords = significantWords(`${title} ${text.slice(0, 200)}`);
  let best: { decision: Decision; score: number } | undefined;
  for (const decision of existing) {
    if (decision.archived) continue;
    const titleScore = overlapRatio(newTitleWords, significantWords(decision.title));
    const bodyScore = overlapRatio(newBodyWords, significantWords(`${decision.title} ${decision.text.slice(0, 200)}`));
    const score = Math.max(titleScore, bodyScore);
    if (score > (best?.score ?? 0)) best = { decision, score };
  }
  return best && best.score > threshold ? best : undefined;
}
