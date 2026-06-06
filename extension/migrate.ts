import { existsSync } from "node:fs";
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Decision } from "./types.ts";
import { DecisionStore } from "./storage.ts";
import { inferTags, projectName } from "./scoring.ts";

type LegacyObservation = {
  id: string;
  timestamp: string;
  cwd: string;
  project: string;
  kind: "tool" | "note" | "turn";
  source: string;
  title: string;
  text: string;
  tags: string[];
  input?: unknown;
};

type LegacyMeta = {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  state?: "active" | "candidate_promote" | "promoted" | "candidate_archive" | "archived";
  retrievalCount?: number;
  injectionCount?: number;
  lastRetrievedAt?: string;
  lastInjectedAt?: string;
  kbPath?: string;
  tags?: string[];
};

type LegacyIndex = { version: number; memories: Record<string, LegacyMeta> };

export type MigrationReport = {
  scanned: number;
  imported: number;
  skipped: number;
  kept: string[];
  legacyObservationsPath: string;
  legacyIndexPath?: string;
};

const DURABLE_TAGS = new Set(["decision", "preference", "workflow", "do-not-repeat", "agent-kb", "extracted-decision"]);

function legacyToDecision(obs: LegacyObservation, meta: LegacyMeta | undefined): Decision | undefined {
  const archived = meta?.state === "archived";
  const promoted = meta?.state === "promoted";
  const tags = new Set<string>([...(obs.tags ?? []), ...(meta?.tags ?? [])]);
  const hasDurableTag = [...tags].some((tag) => DURABLE_TAGS.has(tag));
  const isManual = obs.kind === "note" || obs.source === "manual";
  const wasUsed = ((meta?.retrievalCount ?? 0) + (meta?.injectionCount ?? 0)) > 0;
  if (!isManual && !promoted && !hasDurableTag && !wasUsed) return undefined;
  if (obs.kind === "tool" && !promoted && !hasDurableTag && !wasUsed) return undefined;

  const source: Decision["source"] = isManual ? "manual" : obs.kind === "turn" ? "turn" : "extracted";
  const createdAt = meta?.createdAt ?? obs.timestamp;
  const updatedAt = meta?.updatedAt ?? createdAt;
  return {
    id: obs.id,
    createdAt,
    updatedAt,
    cwd: obs.cwd,
    project: obs.project || projectName(obs.cwd),
    source,
    title: obs.title,
    text: obs.text,
    tags: inferTags(obs.title, obs.text, [...tags]),
    important: promoted || hasDurableTag,
    archived,
    kbPath: meta?.kbPath,
    sourceTurnId: obs.kind === "turn" ? obs.id : undefined,
    retrievalCount: meta?.retrievalCount ?? 0,
    injectionCount: meta?.injectionCount ?? 0,
    lastRetrievedAt: meta?.lastRetrievedAt,
    lastInjectedAt: meta?.lastInjectedAt,
  };
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, "utf8");
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // skip
    }
  }
  return out;
}

export async function migrate(memoryDir: string, store: DecisionStore): Promise<MigrationReport> {
  const observationsPath = join(memoryDir, "observations.jsonl");
  const indexPath = join(memoryDir, "index.json");
  const observations = await readJsonl<LegacyObservation>(observationsPath);

  let index: LegacyIndex | undefined;
  if (existsSync(indexPath)) {
    try {
      index = JSON.parse(await readFile(indexPath, "utf8")) as LegacyIndex;
    } catch {
      index = undefined;
    }
  }
  const metaById = new Map<string, LegacyMeta>(Object.entries(index?.memories ?? {}));

  const existing = await store.all();
  const existingIds = new Set(existing.map((d) => d.id));
  const next: Decision[] = [...existing];
  let imported = 0;
  let skipped = 0;
  for (const obs of observations) {
    if (existingIds.has(obs.id)) continue;
    const decision = legacyToDecision(obs, metaById.get(obs.id));
    if (!decision) {
      skipped += 1;
      continue;
    }
    next.push(decision);
    existingIds.add(obs.id);
    imported += 1;
  }
  next.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  await store.replaceAll(next);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const legacyObsPath = `${observationsPath}.legacy-${stamp}`;
  if (existsSync(observationsPath)) await rename(observationsPath, legacyObsPath);
  let legacyIndexPath: string | undefined;
  if (existsSync(indexPath)) {
    legacyIndexPath = `${indexPath}.legacy-${stamp}`;
    await rename(indexPath, legacyIndexPath);
  }

  return {
    scanned: observations.length,
    imported,
    skipped,
    kept: next.map((d) => d.id),
    legacyObservationsPath: legacyObsPath,
    legacyIndexPath,
  };
}
