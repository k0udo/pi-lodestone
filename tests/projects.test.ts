import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProjectStore } from "../extension/projects.ts";

async function tempProjectStore(): Promise<{ store: ProjectStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-memory-projects-"));
  return { store: new ProjectStore({ path: join(dir, "projects.json") }), dir };
}

test("project store starts with an empty registry", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const registry = await store.read();
    assert.deepEqual(registry, { activeProjectId: undefined, projects: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create registers and activates a project with the cwd root", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const project = await store.create("Pi Lodestone", "/Users/koudo/Repos/pi-lodestone/extension");
    const registry = await store.read();
    assert.match(project.id, /^prj_pi_lodestone_/);
    assert.equal(project.name, "Pi Lodestone");
    assert.deepEqual(project.roots, ["/Users/koudo/Repos/pi-lodestone"]);
    assert.equal(registry.activeProjectId, project.id);
    assert.equal((await store.active())?.id, project.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("create with an existing name switches to the existing project", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const first = await store.create("Pi Lodestone", "/repos/pi-lodestone");
    const second = await store.create("pi lodestone", "/repos/other");
    const registry = await store.read();
    assert.equal(second.id, first.id);
    assert.equal(registry.projects.length, 1);
    assert.equal(registry.activeProjectId, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("use switches by name or id and ignores missing refs", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const first = await store.create("First", "/repos/first");
    const second = await store.create("Second", "/repos/second");
    assert.equal((await store.active())?.id, second.id);
    assert.equal((await store.use("First"))?.id, first.id);
    assert.equal((await store.active())?.id, first.id);
    assert.equal((await store.use(second.id))?.id, second.id);
    assert.equal(await store.use("missing"), undefined);
    assert.equal((await store.active())?.id, second.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("resolveForCwd chooses the most specific linked root", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const broad = await store.create("Broad", "/repos/workspace");
    const specific = await store.create("Specific", "/repos/specific");
    await store.addRoot(specific.id, "/repos/workspace/app");
    assert.equal((await store.resolveForCwd("/repos/workspace/app/src"))?.id, specific.id);
    assert.equal((await store.resolveForCwd("/repos/workspace/docs"))?.id, broad.id);
    assert.equal(await store.resolveForCwd("/repos/workspace-other"), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("activateForCwd switches active project when cwd is inside a linked root", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const first = await store.create("First", "/repos/first");
    const second = await store.create("Second", "/repos/second");
    assert.equal((await store.active())?.id, second.id);
    assert.equal((await store.activateForCwd("/repos/first/src"))?.id, first.id);
    assert.equal((await store.active())?.id, first.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addRoot expands home-relative paths defensively", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const project = await store.create("Notebook", "/repos/notebook");
    const updated = await store.addRoot(project.id, "~/Repos/.ntb");
    assert.ok(updated?.roots.includes(`${homedir()}/Repos/.ntb`));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addRoot and removeRoot update linked folders", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const project = await store.create("Pi Lodestone", "/repos/pi-lodestone");
    const updated = await store.addRoot(project.id, "/repos/pi-lodestone-fixtures/");
    assert.deepEqual(updated?.roots, ["/repos/pi-lodestone", "/repos/pi-lodestone-fixtures"]);
    const removed = await store.removeRoot(project.id, "2");
    assert.equal(removed.removed, "/repos/pi-lodestone-fixtures");
    assert.deepEqual(removed.project?.roots, ["/repos/pi-lodestone"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addContextPath and removeContextPath update project artifacts", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    const project = await store.create("Pi Lodestone", "/repos/pi-lodestone");
    const updated = await store.addContextPath(project.id, "/repos/pi-lodestone/docs/proposals/projects.md");
    assert.deepEqual(updated?.contextPaths, ["/repos/pi-lodestone/docs/proposals/projects.md"]);
    const removed = await store.removeContextPath(project.id, "/repos/pi-lodestone/docs/proposals/projects.md");
    assert.equal(removed.removed, "/repos/pi-lodestone/docs/proposals/projects.md");
    assert.deepEqual(removed.project?.contextPaths, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("invalid active project ids are normalized away", async () => {
  const { store, dir } = await tempProjectStore();
  try {
    await writeFile(store.config.path, JSON.stringify({ activeProjectId: "missing", projects: [] }), "utf8");
    const registry = await store.read();
    assert.equal(registry.activeProjectId, undefined);
    assert.deepEqual(registry.projects, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
