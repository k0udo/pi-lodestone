import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";

export type InjectedMemoryRecord = {
  id: string;
  title: string;
  kind: string;
  source: string;
  score: number;
  snippetLength: number;
};

export type InjectionRecord = {
  ts: string;
  cwd: string;
  project: string;
  promptPreview: string;
  promptCharCount: number;
  results: InjectedMemoryRecord[];
  minScore: number;
  limit: number;
  globalInject: boolean;
};

export async function logInjection(path: string, record: InjectionRecord) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readRecentInjections(path: string, limit: number): Promise<InjectionRecord[]> {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const tail = lines.slice(-Math.max(1, limit));
  const out: InjectionRecord[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as InjectionRecord);
    } catch {
      // skip corrupt line; injection log is an append-only audit trail, not load-bearing data
    }
  }
  return out;
}

export function renderInjections(records: InjectionRecord[]): string {
  if (records.length === 0) return "No memory injections recorded yet.";
  return records.map((rec, i) => {
    const header = `${i + 1}. ${rec.ts} · ${rec.project} · ${rec.results.length}/${rec.limit} memories (minScore ${rec.minScore}${rec.globalInject ? ", global" : ""})`;
    const promptLine = `   prompt(${rec.promptCharCount}): ${rec.promptPreview.replace(/\s+/g, " ").slice(0, 160)}`;
    const memoryLines = rec.results.map((r) => `     [${r.id}] score ${r.score} · ${r.kind}/${r.source} · snip ${r.snippetLength}c · ${r.title}`);
    return [header, promptLine, ...memoryLines].join("\n");
  }).join("\n\n");
}

export type ToolUsageRecord = {
  ts: string;
  tool: string;
  cwd: string;
  project: string;
  resultCount: number;
};

export async function logToolUsage(path: string, record: ToolUsageRecord) {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readRecentToolUsage(path: string, limit: number): Promise<ToolUsageRecord[]> {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean);
  const tail = lines.slice(-Math.max(1, limit));
  const out: ToolUsageRecord[] = [];
  for (const line of tail) {
    try {
      out.push(JSON.parse(line) as ToolUsageRecord);
    } catch {
      // skip corrupt line; usage telemetry is advisory
    }
  }
  return out;
}

export type ToolUsageStats = {
  count: number;
  spanFrom?: string;
  spanTo?: string;
  byTool: { tool: string; count: number; pct: number; avgResultCount: number }[];
};

export function computeToolUsageStats(records: ToolUsageRecord[]): ToolUsageStats {
  const count = records.length;
  if (count === 0) return { count: 0, byTool: [] };
  const byTool = new Map<string, { count: number; totalResults: number }>();
  for (const rec of records) {
    const existing = byTool.get(rec.tool) ?? { count: 0, totalResults: 0 };
    existing.count += 1;
    existing.totalResults += rec.resultCount;
    byTool.set(rec.tool, existing);
  }
  return {
    count,
    spanFrom: records[0].ts,
    spanTo: records[records.length - 1].ts,
    byTool: [...byTool.entries()]
      .map(([tool, v]) => ({ tool, count: v.count, pct: (v.count / count) * 100, avgResultCount: v.totalResults / v.count }))
      .sort((a, b) => b.count - a.count),
  };
}

export function renderToolUsageStats(stats: ToolUsageStats): string {
  if (stats.count === 0) return "No memory tool usage recorded yet.";
  return [
    `Pi memory tool usage — ${stats.count} calls`,
    `Span: ${stats.spanFrom} → ${stats.spanTo}`,
    ...stats.byTool.map((t) => `${t.tool}: ${t.count} calls (${t.pct.toFixed(0)}%) · avg results ${t.avgResultCount.toFixed(1)}`),
  ].join("\n");
}

export type InjectionStats = {
  count: number;
  spanFrom?: string;
  spanTo?: string;
  resultCountAvg: number;
  resultCountP50: number;
  resultCountP95: number;
  hitLimitPct: number;
  zeroResultPct: number;
  topScoreAvg: number;
  topScoreMin: number;
  topScoreMax: number;
  tailScoreAvg: number;
  minScore: number;
  limit: number;
  snippetLengthAvg: number;
  estTokensPerTurn: number;
  topInjected: { id: string; count: number; avgScore: number; title: string }[];
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeInjectionStats(records: InjectionRecord[]): InjectionStats {
  const count = records.length;
  if (count === 0) {
    return {
      count: 0,
      resultCountAvg: 0, resultCountP50: 0, resultCountP95: 0,
      hitLimitPct: 0, zeroResultPct: 0,
      topScoreAvg: 0, topScoreMin: 0, topScoreMax: 0, tailScoreAvg: 0,
      minScore: 0, limit: 0,
      snippetLengthAvg: 0, estTokensPerTurn: 0,
      topInjected: [],
    };
  }
  const resultCounts = records.map((r) => r.results.length).sort((a, b) => a - b);
  const topScores = records.map((r) => r.results[0]?.score ?? 0);
  const tailScores = records.map((r) => r.results.at(-1)?.score ?? 0);
  const snippetLens = records.flatMap((r) => r.results.map((m) => m.snippetLength));
  const hitLimit = records.filter((r) => r.results.length >= r.limit).length;
  const zeroResult = records.filter((r) => r.results.length === 0).length;

  const idCounts = new Map<string, { count: number; totalScore: number; title: string }>();
  for (const rec of records) {
    for (const m of rec.results) {
      const existing = idCounts.get(m.id) ?? { count: 0, totalScore: 0, title: m.title };
      existing.count += 1;
      existing.totalScore += m.score;
      existing.title = m.title;
      idCounts.set(m.id, existing);
    }
  }
  const topInjected = [...idCounts.entries()]
    .map(([id, v]) => ({ id, count: v.count, avgScore: v.totalScore / v.count, title: v.title }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  const lastRec = records[records.length - 1];
  return {
    count,
    spanFrom: records[0].ts,
    spanTo: lastRec.ts,
    resultCountAvg: mean(resultCounts),
    resultCountP50: percentile(resultCounts, 50),
    resultCountP95: percentile(resultCounts, 95),
    hitLimitPct: (hitLimit / count) * 100,
    zeroResultPct: (zeroResult / count) * 100,
    topScoreAvg: mean(topScores),
    topScoreMin: Math.min(...topScores),
    topScoreMax: Math.max(...topScores),
    tailScoreAvg: mean(tailScores),
    minScore: lastRec.minScore,
    limit: lastRec.limit,
    snippetLengthAvg: mean(snippetLens),
    estTokensPerTurn: Math.round((mean(snippetLens) * mean(resultCounts)) / 4),
    topInjected,
  };
}

export function renderInjectionStats(stats: InjectionStats): string {
  if (stats.count === 0) return "No memory injections recorded yet.";
  const tailVsMin = stats.tailScoreAvg - stats.minScore;
  const tailNote = tailVsMin < 3 ? " (threshold is doing real work)" : "";
  return [
    `Pi memory injection stats — ${stats.count} events`,
    `Span: ${stats.spanFrom} → ${stats.spanTo}`,
    `Result count: avg ${stats.resultCountAvg.toFixed(1)} · p50 ${stats.resultCountP50} · p95 ${stats.resultCountP95} · hit_limit ${stats.hitLimitPct.toFixed(0)}% · zero ${stats.zeroResultPct.toFixed(0)}%`,
    `Top score: avg ${stats.topScoreAvg.toFixed(1)} · min ${stats.topScoreMin} · max ${stats.topScoreMax}`,
    `Tail (lowest injected) score: avg ${stats.tailScoreAvg.toFixed(1)} vs minScore ${stats.minScore}${tailNote}`,
    `Snippet len: avg ${stats.snippetLengthAvg.toFixed(0)}c · est ~${stats.estTokensPerTurn} tokens/turn on memory`,
    `Limit in effect: ${stats.limit}`,
    "Top injected (by count):",
    ...stats.topInjected.map((t) => `  ${t.count}× avg score ${t.avgScore.toFixed(1)} · [${t.id}] ${t.title}`),
  ].join("\n");
}
