import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { resolveProjectPath } from "./paths.ts";
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

function normalizePath(path: string) {
  return resolveProjectPath("/", path).replace(/\/+$/g, "") || "/";
}

function normalizePaths(paths: unknown) {
  return Array.isArray(paths) ? [...new Set(paths.filter(Boolean).map((p) => normalizePath(String(p))))].sort() : [];
}

function pathIsInsideRoot(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function normalizeRegistry(value: unknown): ProjectRegistry {
  const input = (value && typeof value === "object") ? value as Partial<ProjectRegistry> : {};
  const projects = Array.isArray(input.projects)
    ? input.projects.filter((p): p is ProjectRecord => Boolean(p?.id && p?.name)).map((p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt ?? p.createdAt,
      roots: normalizePaths(p.roots),
      contextPaths: normalizePaths(p.contextPaths),
      artifactPaths: normalizePaths(p.artifactPaths),
      archived: p.archived ?? false,
    }))
    : [];
  const activeProjectId = input.activeProjectId && projects.some((p) => p.id === input.activeProjectId && !p.archived)
    ? input.activeProjectId
    : undefined;
  return { activeProjectId, projects };
}

function removeByRef(items: string[], ref: string) {
  const clean = cleanName(ref);
  const numeric = /^\d+$/.test(clean) ? Number(clean) : undefined;
  const target = numeric ? items[numeric - 1] : normalizePath(clean);
  if (!target) return { next: items, removed: undefined };
  const next = items.filter((item) => item !== target);
  return { next, removed: next.length === items.length ? undefined : target };
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

  private async commit(registry: ProjectRegistry) {
    await this.writeAtomic(registry);
    this.cache = { mtimeMs: (await stat(this.config.path)).mtimeMs, registry };
  }

  private findById(registry: ProjectRegistry, projectId: string) {
    return registry.projects.find((p) => p.id === projectId && !p.archived);
  }

  private updateProject(registry: ProjectRegistry, projectId: string, update: (project: ProjectRecord) => ProjectRecord): ProjectRegistry | undefined {
    let changed = false;
    const projects = registry.projects.map((project) => {
      if (project.id !== projectId || project.archived) return project;
      changed = true;
      return update(project);
    });
    return changed ? { ...registry, projects } : undefined;
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
        await this.commit(next);
        return existing;
      }
      const now = new Date().toISOString();
      const project: ProjectRecord = {
        id: makeProjectId(clean),
        name: clean,
        createdAt: now,
        updatedAt: now,
        roots: cwd ? [projectRoot(cwd)] : [],
        contextPaths: [],
        artifactPaths: [],
        archived: false,
      };
      const next = { activeProjectId: project.id, projects: [...registry.projects, project] };
      await this.commit(next);
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
      await this.commit(next);
      return target;
    });
  }

  async resolveForCwd(cwd: string): Promise<ProjectRecord | undefined> {
    const registry = await this.read();
    const path = normalizePath(cwd);
    return registry.projects
      .filter((p) => !p.archived)
      .flatMap((project) => project.roots.map((root) => ({ project, root })))
      .filter(({ root }) => pathIsInsideRoot(path, root))
      .sort((a, b) => b.root.length - a.root.length || a.project.name.localeCompare(b.project.name))[0]?.project;
  }

  async activateForCwd(cwd: string): Promise<ProjectRecord | undefined> {
    const project = await this.resolveForCwd(cwd);
    if (!project) return undefined;
    await this.setActiveProjectId(project.id);
    return project;
  }

  async addRoot(projectId: string, path: string): Promise<ProjectRecord | undefined> {
    const root = normalizePath(path);
    return this.withMutation(async () => {
      const registry = await this.read();
      const next = this.updateProject(registry, projectId, (project) => ({
        ...project,
        roots: [...new Set([...project.roots, root])].sort(),
        updatedAt: new Date().toISOString(),
      }));
      if (!next) return undefined;
      await this.commit(next);
      return this.findById(next, projectId);
    });
  }

  async removeRoot(projectId: string, ref: string): Promise<{ project?: ProjectRecord; removed?: string }> {
    return this.withMutation(async () => {
      const registry = await this.read();
      const project = this.findById(registry, projectId);
      if (!project) return {};
      const { next: roots, removed } = removeByRef(project.roots, ref);
      if (!removed) return { project };
      const next = this.updateProject(registry, projectId, (p) => ({ ...p, roots, updatedAt: new Date().toISOString() }));
      if (!next) return { project };
      await this.commit(next);
      return { project: this.findById(next, projectId), removed };
    });
  }

  async addContextPath(projectId: string, path: string): Promise<ProjectRecord | undefined> {
    const contextPath = normalizePath(path);
    return this.withMutation(async () => {
      const registry = await this.read();
      const next = this.updateProject(registry, projectId, (project) => ({
        ...project,
        contextPaths: [...new Set([...(project.contextPaths ?? []), contextPath])].sort(),
        updatedAt: new Date().toISOString(),
      }));
      if (!next) return undefined;
      await this.commit(next);
      return this.findById(next, projectId);
    });
  }

  async removeContextPath(projectId: string, ref: string): Promise<{ project?: ProjectRecord; removed?: string }> {
    return this.withMutation(async () => {
      const registry = await this.read();
      const project = this.findById(registry, projectId);
      if (!project) return {};
      const { next: contextPaths, removed } = removeByRef(project.contextPaths ?? [], ref);
      if (!removed) return { project };
      const next = this.updateProject(registry, projectId, (p) => ({ ...p, contextPaths, updatedAt: new Date().toISOString() }));
      if (!next) return { project };
      await this.commit(next);
      return { project: this.findById(next, projectId), removed };
    });
  }

  async setActiveProjectId(projectId: string | undefined): Promise<void> {
    return this.withMutation(async () => {
      const registry = await this.read();
      const activeProjectId = projectId && registry.projects.some((p) => p.id === projectId && !p.archived) ? projectId : undefined;
      const next = { ...registry, activeProjectId };
      await this.commit(next);
    });
  }
}
