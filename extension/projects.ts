import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { projectRoot } from "./scoring.ts";
import type { ProjectRecord, ProjectRegistry } from "./types.ts";

export type ProjectStoreConfig = {
  path: string;
};

function slugify(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "project";
}

function makeProjectId(name: string) {
  return `prj_${slugify(name)}_${Date.now().toString(36).slice(-6)}`;
}

function cleanName(name: string) {
  return name.replace(/\s+/g, " ").trim();
}

function normalizeRegistry(value: unknown): ProjectRegistry {
  const input = (value && typeof value === "object") ? value as Partial<ProjectRegistry> : {};
  const projects = Array.isArray(input.projects)
    ? input.projects.filter((p): p is ProjectRecord => Boolean(p?.id && p?.name)).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? p.createdAt,
      roots: Array.isArray(p.roots) ? [...new Set(p.roots.filter(Boolean))].sort() : [],
      archived: p.archived ?? false,
    }))
    : [];
  const activeProjectId = input.activeProjectId && projects.some((p) => p.id === input.activeProjectId && !p.archived)
    ? input.activeProjectId
    : undefined;
  return { activeProjectId, projects };
}

export class ProjectStore {
  public readonly config: ProjectStoreConfig;
  private cache: { mtimeMs: number; registry: ProjectRegistry } | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(config: ProjectStoreConfig) {
    this.config = config;
  }

  private withMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(operation);
    this.mutationQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async writeAtomic(registry: ProjectRegistry) {
    await mkdir(dirname(this.config.path), { recursive: true });
    const tmp = `${this.config.path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
      await rename(tmp, this.config.path);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  async ensure() {
    await mkdir(dirname(this.config.path), { recursive: true });
    if (!existsSync(this.config.path)) await writeFile(this.config.path, `${JSON.stringify({ projects: [] }, null, 2)}\n`, "utf8");
  }

  async read(): Promise<ProjectRegistry> {
    await this.ensure();
    const st = await stat(this.config.path);
    if (this.cache?.mtimeMs === st.mtimeMs) return this.cache.registry;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.config.path, "utf8"));
    } catch {
      parsed = { projects: [] };
    }
    const registry = normalizeRegistry(parsed);
    this.cache = { mtimeMs: st.mtimeMs, registry };
    return registry;
  }

  async active(): Promise<ProjectRecord | undefined> {
    const registry = await this.read();
    return registry.projects.find((p) => p.id === registry.activeProjectId && !p.archived);
  }

  async create(name: string, cwd?: string): Promise<ProjectRecord> {
    const clean = cleanName(name);
    if (!clean) throw new Error("Project name is required.");
    return this.withMutation(async () => {
      const registry = await this.read();
      const existing = registry.projects.find((p) => p.name.toLowerCase() === clean.toLowerCase() && !p.archived);
      if (existing) {
        const next = { ...registry, activeProjectId: existing.id };
        await this.writeAtomic(next);
        this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, registry: next };
        return existing;
      }
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: makeProjectId(clean),
        name: clean,
        createdAt: now,
        updatedAt: now,
        roots: cwd ? [projectRoot(cwd)] : [],
        archived: false,
      };
      const next = { activeProjectId: project.id, projects: [...registry.projects, project] };
      await this.writeAtomic(next);
      this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, registry: next };
      return project;
    });
  }

  async use(ref: string): Promise<ProjectRecord | undefined> {
    const clean = cleanName(ref);
    if (!clean) return undefined;
    return this.withMutation(async () => {
      const registry = await this.read();
      const target = registry.projects.find((p) => !p.archived && (p.id === clean || p.name.toLowerCase() === clean.toLowerCase()));
      if (!target) return undefined;
      const next = { ...registry, activeProjectId: target.id };
      await this.writeAtomic(next);
      this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, registry: next };
      return target;
    });
  }

  async setActiveProjectId(projectId: string | undefined): Promise<void> {
    return this.withMutation(async () => {
      const registry = await this.read();
      const activeProjectId = projectId && registry.projects.some((p) => p.id === projectId && !p.archived) ? projectId : undefined;
      const next = { ...registry, activeProjectId };
      await this.writeAtomic(next);
      this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, registry: next };
    });
  }
}
