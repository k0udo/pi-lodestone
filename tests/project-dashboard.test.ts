import { strict as assert } from "node:assert";
import { test } from "node:test";
import { borderedLines, projectDashboardLines } from "../extension/project-dashboard.ts";
import type { Decision, ProjectRecord, ProjectRegistry, ProjectSessionRecord } from "../extension/types.ts";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "prj_lodestone",
    name: "pi-lodestone",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roots: ["/repos/pi-lodestone"],
    contextPaths: ["/repos/pi-lodestone/README.md"],
    artifactPaths: [],
    archived: false,
    ...overrides,
  };
}

function registry(selected = project()): ProjectRegistry {
  return { activeProjectId: selected.id, projects: [selected] };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "mem-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    cwd: "/repos/pi-lodestone",
    project: "pi-lodestone",
    projectId: "prj_lodestone",
    source: "manual",
    title: "Pinned workflow",
    text: "Pinned workflow details",
    tags: [],
    important: true,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

function session(overrides: Partial<ProjectSessionRecord> = {}): ProjectSessionRecord {
  return {
    id: "ses-1",
    projectId: "prj_lodestone",
    cwd: "/repos/pi-lodestone",
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    title: "Dashboard polish",
    decisionIds: [],
    artifactPaths: [],
    ...overrides,
  };
}

test("projectDashboardLines shows active state and section counts", () => {
  const selected = project();
  const lines = projectDashboardLines({
    registry: registry(selected),
    selected,
    activeId: selected.id,
    cwd: "/repos/pi-lodestone/src",
    decisions: [decision()],
    sessions: [session()],
  }).join("\n");
  assert.match(lines, /Status: active · Inside linked folder/);
  assert.match(lines, /1 linked folder/);
  assert.match(lines, /1 context\/artifact path/);
  assert.match(lines, /1 recent session/);
  assert.match(lines, /1 pinned memory/);
  assert.match(lines, /Dashboard polish/);
  assert.match(lines, /▶ SELECTED \* 1\. pi-lodestone \[prj_lodestone\] active/);
});

test("projectDashboardLines has helpful empty states", () => {
  const selected = project({ roots: [], contextPaths: [], artifactPaths: [] });
  const lines = projectDashboardLines({ registry: registry(selected), selected, activeId: selected.id, cwd: "/tmp", decisions: [], sessions: [] }).join("\n");
  assert.match(lines, /No folders linked/);
  assert.match(lines, /No context paths linked/);
  assert.match(lines, /No related sessions indexed yet/);
  assert.match(lines, /No pinned memories/);
});

test("borderedLines keeps rendered lines within width", () => {
  const rendered = borderedLines("Project: a very long dashboard title", ["body line"], 50);
  assert.ok(rendered.every((line) => line.length <= 50));
  assert.match(rendered[0], /^╭─/);
  assert.match(rendered.at(-1) ?? "", /^╰/);
});
