import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProjectSessionRecord } from "./types.ts";
import { textFromContent } from "./text.ts";

export type SessionStoreConfig = {
  path: string;
};

type Cache = { mtimeMs: number; sessions: ProjectSessionRecord[] } | undefined;

function hash(input: string) {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function firstUserPrompt(entries: unknown[]) {
  for (const entry of entries as any[]) {
    const message = entry?.type === "message" ? entry.message : entry?.message ?? entry;
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).replace(/\s+/g, " ").trim();
    if (text) return { text, timestamp: String(message.timestamp ?? entry?.timestamp ?? "") };
  }
  return { text: "", timestamp: "" };
}

export function deriveSessionId(sessionFile: string | undefined, entries: unknown[] = [], cwd = "") {
  if (sessionFile) return `ses_file_${hash(sessionFile)}`;
  const first = firstUserPrompt(entries);
  return `ses_${hash(`${first.timestamp}\n${first.text}\n${cwd}`)}`;
}

export function titleFromEntries(entries: unknown[]) {
  const messages = (entries as any[])
    .map((entry) => entry?.type === "message" ? entry.message : entry?.message ?? entry)
    .filter(Boolean);
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    const text = textFromContent(message.content).replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 120);
  }
  return undefined;
}

function normalizeSession(value: unknown): ProjectSessionRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<ProjectSessionRecord>;
  if (!input.id || !input.projectId || !input.cwd || !input.startedAt || !input.updatedAt) return undefined;
  return {
    id: input.id,
    projectId: input.projectId,
    sessionFile: input.sessionFile,
    cwd: input.cwd,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt,
    title: input.title,
    summary: input.summary,
    decisionIds: Array.isArray(input.decisionIds) ? [...new Set(input.decisionIds.filter(Boolean))].sort() : [],
    artifactPaths: Array.isArray(input.artifactPaths) ? [...new Set(input.artifactPaths.filter(Boolean))].sort() : [],
  };
}

export class SessionStore {
  public readonly config: SessionStoreConfig;
  private cache: Cache;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(config: SessionStoreConfig) {
    this.config = config;
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeAtomic(sessions: ProjectSessionRecord[]) {
    await mkdir(dirname(this.config.path), { recursive: true });
    const body = sessions.map((session) => JSON.stringify(session)).join("\n");
    const tmp = `${this.config.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, body ? `${body}\n` : "", "utf8");
      await rename(tmp, this.config.path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async ensure() {
    await mkdir(dirname(this.config.path), { recursive: true });
    if (!existsSync(this.config.path)) await writeFile(this.config.path, "", "utf8");
  }

  async all(): Promise<ProjectSessionRecord[]> {
    await this.ensure();
    const st = await stat(this.config.path);
    if (this.cache?.mtimeMs === st.mtimeMs) return this.cache.sessions;
    const raw = await readFile(this.config.path, "utf8");
    const sessions: ProjectSessionRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const session = normalizeSession(JSON.parse(line));
        if (session) sessions.push(session);
      } catch {
        // Skip corrupt session index lines; session records are advisory.
      }
    }
    this.cache = { mtimeMs: st.mtimeMs, sessions };
    return sessions;
  }

  async upsert(record: ProjectSessionRecord): Promise<ProjectSessionRecord> {
    return this.withMutation(async () => {
      const current = await this.all();
      const idx = current.findIndex((session) => session.id === record.id);
      if (idx >= 0) current[idx] = { ...current[idx], ...record };
      else current.push(record);
      await this.writeAtomic(current);
      this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, sessions: current };
      return record;
    });
  }

  async patch(id: string, patch: Partial<ProjectSessionRecord>): Promise<ProjectSessionRecord | undefined> {
    return this.withMutation(async () => {
      const current = await this.all();
      const idx = current.findIndex((session) => session.id === id);
      if (idx < 0) return undefined;
      current[idx] = { ...current[idx], ...patch, updatedAt: patch.updatedAt ?? new Date().toISOString() };
      await this.writeAtomic(current);
      this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, sessions: current };
      return current[idx];
    });
  }

  async recent(projectId: string, limit = 5): Promise<ProjectSessionRecord[]> {
    return (await this.all())
      .filter((session) => session.projectId === projectId)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.startedAt) - Date.parse(a.startedAt))
      .slice(0, Math.max(0, limit));
  }

  async append(record: ProjectSessionRecord): Promise<ProjectSessionRecord> {
    return this.withMutation(async () => {
      await this.ensure();
      await appendFile(this.config.path, `${JSON.stringify(record)}\n`, "utf8");
      this.cache = undefined;
      return record;
    });
  }
}
