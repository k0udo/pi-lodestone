import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { INJECTION_LOG_FILE, OBSERVATIONS_LOG_FILE, TOOL_USAGE_LOG_FILE } from "./config.ts";
import type { Decision } from "./types.ts";

// Review-only staleness analysis. Reads the optional diagnostic/legacy logs to
// estimate which memories have aged out without being referenced. Advisory only:
// it never mutates the store, and missing/corrupt logs degrade gracefully.

export type MemoryLike = Pick<Decision, "id" | "title" | "createdAt" | "updatedAt" | "text" | "archived" | "lastRetrievedAt" | "lastInjectedAt">;
export type StaleRow = { entry: MemoryLike; ageDays: number; lastReferenced?: string };

function parseJsonLines(text: string): any[] {
  const rows: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore corrupt log lines; staleness is advisory only.
    }
  }
  return rows;
}

async function readMemoryLikeEntries(fallback: Decision[]): Promise<MemoryLike[]> {
  if (!existsSync(OBSERVATIONS_LOG_FILE)) return fallback;
  const rows = parseJsonLines(await readFile(OBSERVATIONS_LOG_FILE, "utf8"));
  return rows
    .map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? row.summary ?? "Untitled memory"),
      createdAt: String(row.createdAt ?? row.timestamp ?? row.ts ?? ""),
      updatedAt: String(row.updatedAt ?? row.timestamp ?? row.ts ?? ""),
      text: String(row.text ?? ""),
      archived: row.archived === true || row.state === "archived",
      lastRetrievedAt: typeof row.lastRetrievedAt === "string" ? row.lastRetrievedAt : undefined,
      lastInjectedAt: typeof row.lastInjectedAt === "string" ? row.lastInjectedAt : undefined,
    }))
    .filter((row) => row.id && Number.isFinite(Date.parse(row.createdAt)));
}

async function readLastReferences(): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const note = (id: unknown, ts: unknown) => {
    if (typeof id !== "string" || typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) return;
    const prev = refs.get(id);
    if (!prev || Date.parse(ts) > Date.parse(prev)) refs.set(id, ts);
  };
  if (existsSync(TOOL_USAGE_LOG_FILE)) {
    for (const row of parseJsonLines(await readFile(TOOL_USAGE_LOG_FILE, "utf8"))) {
      for (const id of row.resultIds ?? row.returnedIds ?? row.requestedIds ?? row.details?.resultIds ?? row.details?.returnedIds ?? []) note(id, row.ts);
    }
  }
  if (existsSync(INJECTION_LOG_FILE)) {
    for (const row of parseJsonLines(await readFile(INJECTION_LOG_FILE, "utf8"))) {
      for (const result of row.results ?? []) note(result?.id, row.ts);
    }
  }
  return refs;
}

function latestIso(...values: (string | undefined)[]): string | undefined {
  return values.filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export async function staleMemories(days: number, fallback: Decision[]): Promise<StaleRow[]> {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const [entries, refs] = await Promise.all([readMemoryLikeEntries(fallback), readLastReferences()]);
  return entries
    .filter((entry) => !entry.archived && Date.parse(entry.createdAt) < cutoffMs)
    .map((entry) => {
      const lastReferenced = latestIso(refs.get(entry.id), entry.lastRetrievedAt, entry.lastInjectedAt);
      return { entry, ageDays: Math.floor((Date.now() - Date.parse(entry.createdAt)) / (24 * 60 * 60 * 1000)), lastReferenced };
    })
    .filter((row) => !row.lastReferenced || Date.parse(row.lastReferenced) < cutoffMs)
    .sort((a, b) => (Date.parse(a.lastReferenced ?? "1970-01-01") - Date.parse(b.lastReferenced ?? "1970-01-01")) || Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt))
    .slice(0, 20);
}

export function renderStaleness(rows: StaleRow[], days: number): string {
  if (rows.length === 0) return `No stale memories older than ${days} days.`;
  return [
    `Stale memory candidates (> ${days} days old, max 20; review-only):`,
    ...rows.map(({ entry, ageDays, lastReferenced }, i) => `${i + 1}. [${entry.id}] ${entry.title} · age ${ageDays}d · last referenced ${lastReferenced ? lastReferenced.slice(0, 10) : "unknown"}`),
  ].join("\n");
}
