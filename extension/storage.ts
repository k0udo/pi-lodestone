import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Decision, DecisionPatch, Settings } from "./types.ts";

export type StoreConfig = {
  decisionsPath: string;
  settingsPath: string;
  lockDir: string;
  lockStaleMs: number;
};

type Cache = { mtimeMs: number; decisions: Decision[] } | undefined;

export class DecisionStore {
  public readonly config: StoreConfig;
  private cache: Cache;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(config: StoreConfig) {
    this.config = config;
  }

  private async sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.config.lockDir), { recursive: true });
    while (true) {
      try {
        await mkdir(this.config.lockDir);
        return async () => {
          await rm(this.config.lockDir, { recursive: true, force: true }).catch(() => undefined);
        };
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const lockStat = await stat(this.config.lockDir);
          if (Date.now() - lockStat.mtimeMs > this.config.lockStaleMs) {
            await rm(this.config.lockDir, { recursive: true, force: true }).catch(() => undefined);
            continue;
          }
        } catch {
          continue;
        }
        await this.sleep(25 + Math.floor(Math.random() * 50));
      }
    }
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(async () => {
      const release = await this.acquireLock();
      try {
        return await operation();
      } finally {
        await release();
      }
    });
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeAtomic(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, content, "utf8");
      await rename(tmp, path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async ensure() {
    await mkdir(dirname(this.config.decisionsPath), { recursive: true });
    if (!existsSync(this.config.decisionsPath)) await writeFile(this.config.decisionsPath, "", "utf8");
    if (!existsSync(this.config.settingsPath)) await writeFile(this.config.settingsPath, JSON.stringify({ disabledProjects: [] }, null, 2), "utf8");
  }

  /**
   * Cached read. The cache key is the file's mtimeMs; foreign writes (other Pi
   * processes, manual edits, migration) bump mtime so the cache reloads.
   */
  async all(): Promise<Decision[]> {
    await this.ensure();
    const st = await stat(this.config.decisionsPath);
    if (this.cache && this.cache.mtimeMs === st.mtimeMs) return this.cache.decisions;
    const raw = await readFile(this.config.decisionsPath, "utf8");
    const decisions: Decision[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        decisions.push(JSON.parse(line) as Decision);
      } catch {
        // skip corrupt line; decisions are recoverable individually
      }
    }
    this.cache = { mtimeMs: st.mtimeMs, decisions };
    return decisions;
  }

  async byId(id: string): Promise<Decision | undefined> {
    return (await this.all()).find((d) => d.id === id);
  }

  /** Replace the entire store with the given list. Used by migration and by patch operations that modify existing records. */
  async replaceAll(decisions: Decision[]): Promise<void> {
    return this.withMutation(async () => {
      const body = decisions.map((d) => JSON.stringify(d)).join("\n");
      await this.writeAtomic(this.config.decisionsPath, body ? `${body}\n` : "");
      const st = await stat(this.config.decisionsPath);
      this.cache = { mtimeMs: st.mtimeMs, decisions };
    });
  }

  async add(decision: Decision): Promise<Decision> {
    return this.withMutation(async () => {
      await this.ensure();
      const current = await this.loadFromDisk();
      current.push(decision);
      const body = current.map((d) => JSON.stringify(d)).join("\n");
      await this.writeAtomic(this.config.decisionsPath, `${body}\n`);
      const st = await stat(this.config.decisionsPath);
      this.cache = { mtimeMs: st.mtimeMs, decisions: current };
      return decision;
    });
  }

  async patch(id: string, patch: DecisionPatch): Promise<Decision | undefined> {
    return this.withMutation(async () => {
      const current = await this.loadFromDisk();
      const idx = current.findIndex((d) => d.id === id);
      if (idx < 0) return undefined;
      const now = new Date().toISOString();
      current[idx] = { ...current[idx], ...patch, updatedAt: now };
      const body = current.map((d) => JSON.stringify(d)).join("\n");
      await this.writeAtomic(this.config.decisionsPath, `${body}\n`);
      const st = await stat(this.config.decisionsPath);
      this.cache = { mtimeMs: st.mtimeMs, decisions: current };
      return current[idx];
    });
  }

  async bumpUse(ids: string[], usage: "retrieved" | "injected") {
    if (ids.length === 0) return;
    return this.withMutation(async () => {
      const current = await this.loadFromDisk();
      const now = new Date().toISOString();
      const ids_set = new Set(ids);
      let changed = false;
      for (const decision of current) {
        if (!ids_set.has(decision.id)) continue;
        if (usage === "retrieved") {
          decision.retrievalCount += 1;
          decision.lastRetrievedAt = now;
        } else {
          decision.injectionCount += 1;
          decision.lastInjectedAt = now;
        }
        decision.updatedAt = now;
        changed = true;
      }
      if (!changed) return;
      const body = current.map((d) => JSON.stringify(d)).join("\n");
      await this.writeAtomic(this.config.decisionsPath, `${body}\n`);
      const st = await stat(this.config.decisionsPath);
      this.cache = { mtimeMs: st.mtimeMs, decisions: current };
    });
  }

  async readSettings(): Promise<Settings> {
    await this.ensure();
    try {
      return JSON.parse(await readFile(this.config.settingsPath, "utf8")) as Settings;
    } catch {
      return { disabledProjects: [] };
    }
  }

  async writeSettings(settings: Settings) {
    await this.ensure();
    await this.writeAtomic(this.config.settingsPath, JSON.stringify({ disabledProjects: settings.disabledProjects ?? [] }, null, 2));
  }

  invalidateCache() {
    this.cache = undefined;
  }

  private async loadFromDisk(): Promise<Decision[]> {
    await this.ensure();
    const raw = await readFile(this.config.decisionsPath, "utf8");
    const decisions: Decision[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        decisions.push(JSON.parse(line) as Decision);
      } catch {
        // skip corrupt line; intentional record loss is preferable to write amplification
      }
    }
    return decisions;
  }
}

export function defaultStoreConfig(memoryDir: string): StoreConfig {
  return {
    decisionsPath: join(memoryDir, "decisions.jsonl"),
    settingsPath: join(memoryDir, "settings.json"),
    lockDir: join(memoryDir, ".lock"),
    lockStaleMs: 30_000,
  };
}
