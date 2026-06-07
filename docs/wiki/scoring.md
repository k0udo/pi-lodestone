# Scoring model

`extension/scoring.ts` implements the retrieval scoring function. It is deterministic, lexical, and has no model calls or embeddings.

## `scoreDecision` signature

```ts
scoreDecision(
  decision: Decision,
  query: string,
  cwd: string | undefined,
  options: { now?: number; forInjection?: boolean; tokenWeights?: TokenWeights },
): number
```

`now` is injected so tests can pin the clock. `forInjection` controls stricter filtering for automatic injection vs manual search.

## Tokenization

```ts
tokenize(text: string): string[]
```

- Lowercases, extracts alphanumeric/underscore/segment tokens of length ≥ 3.
- Drops English stop words (`STOP_WORDS`).
- Results feed both the query and decision-side token sets.

## IDF-style corpus weighting

`buildTokenWeights(decisions: Decision[]): Map<string, number>` computes a tiny IDF weight per corpus token:

```
weight(token) = 0.75 + min(1.75, log((active_count + 1) / (doc_freq + 1)))
```

Rare tokens get a capped boost; common corpus terms get slightly damped. This is a lightweight approximation of TF-IDF that does not require term frequency within a single decision.

## Lexical scoring

For each query token:

| Match location | Base score |
|---|---|
| Decision title | 6 |
| Decision tags | 4 |
| Decision body | 3 |
| Partial match (substring) | 1 |

Each match is multiplied by the token's IDF weight. The lexical total is the sum.

If lexical is 0, score is 0 — no overlap means no injection.

## Auto-injection filters (`forInjection === true`)

These gates run before the lexical total is computed:

1. **Archived** → 0.
2. **Superseded** → 0.
3. **Source `turn`** → 0 (these are session artifacts, not durable decisions).
4. **Operational titles** → 0 (titles starting with `read`, `ran`, `executed`, `wrote`, etc.).
5. **Non-manual without durable tags** → 0 (entries without `decision`/`preference`/`workflow` tags unless source is `manual`).
6. **Single-token evidence** → 0 (auto-injection requires ≥ 2 strong matches).
7. **No meaningful evidence** → 0 (requires ≥ 1 non-generic match; generic terms like "decision" and "workflow" don't count alone).
8. **Long prompt dampening** → if query ≥ 5 tokens, requires ≥ 3 meaningful matches.
9. **Very long prompt** → if query > 8 tokens, lexical total is damped by `sqrt(8 / q.length)`.

## Score bonuses (after lexical)

| Condition | Bonus (injection) | Bonus (manual) |
|---|---|---|
| Exact cwd match | +6 | +6 |
| Same project root | +4 | +4 |
| Same project name | +2 | +2 |
| `important` flag | +4 | +8 |
| `source: manual` | +2 | +4 |
| Has `kbPath` | +3 | +3 |
| < 1 day old | +2 | +2 |
| 1–14 days old | +1 | +1 |
| > 180 days old | −2 | −2 |
| Prior retrieval count | — | +min(count, 6) |
| Prior injection count | — | +min(count, 4) |
| Has `supersededBy` | — | −4 |

## Modifying the scoring model

When changing scoring logic:

1. Update `tests/scoring.test.ts` to cover the new behavior.
2. Update `tests/fixtures/eval.jsonl` if the change affects recall/precision on known queries.
3. Check `/memory why-stats` output to see if threshold tuning is needed.
4. Preserve the invariant: zero lexical overlap → score 0.
5. Keep auto-injection stricter than manual search.

## Diagnostic stats

When `PI_MEMORY_DIAGNOSTIC_LOGS=true`, injection events are logged to `injections.jsonl`. Use:

- `/memory why [n]` — recent injection decisions.
- `/memory why-stats [n]` — aggregate stats (result count percentiles, score ranges, top injected IDs, estimated tokens per turn).

These are useful for tuning `PI_MEMORY_INJECT_MIN_SCORE` and `PI_MEMORY_INJECT_LIMIT`.
