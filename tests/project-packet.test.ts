import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildProjectPacket } from "../extension/project-packet.ts";
import type { Decision, ProjectRecord } from "../extension/types.ts";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "prj_lodestone",
    name: "pi-lodestone",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roots: ["/Users/koudo/Repos/pi-lodestone"],
    contextPaths: ["/Users/koudo/Repos/pi-lodestone/docs/proposals/projects.md"],
    artifactPaths: [],
    archived: false,
    ...overrides,
  };
}

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: "mem-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    cwd: "/Users/koudo/Repos/pi-lodestone",
    project: "pi-lodestone",
    projectId: "prj_lodestone",
    source: "manual",
    title: "Local dev install workflow",
    text: "Use the local repo path for faster Pi package testing.",
    tags: ["workflow"],
    important: true,
    archived: false,
    retrievalCount: 0,
    injectionCount: 0,
    ...overrides,
  };
}

test("buildProjectPacket includes project references and pinned memories", () => {
  const packet = buildProjectPacket(project(), [decision()]);
  assert.match(packet, /## Project: pi-lodestone/);
  assert.match(packet, /\/Users\/koudo\/Repos\/pi-lodestone/);
  assert.match(packet, /docs\/proposals\/projects.md/);
  assert.match(packet, /\[mem-1\] ★ Local dev install workflow/);
});

test("buildProjectPacket filters pinned memories by projectId", () => {
  const packet = buildProjectPacket(project(), [
    decision({ id: "keep", projectId: "prj_lodestone", title: "Keep me" }),
    decision({ id: "skip", projectId: "prj_other", title: "Skip me" }),
    decision({ id: "archived", title: "Archived", archived: true }),
    decision({ id: "unpinned", title: "Unpinned", important: false }),
  ]);
  assert.match(packet, /Keep me/);
  assert.doesNotMatch(packet, /Skip me/);
  assert.doesNotMatch(packet, /Archived/);
  assert.doesNotMatch(packet, /Unpinned/);
});

test("buildProjectPacket returns bounded output", () => {
  const packet = buildProjectPacket(project({ contextPaths: Array.from({ length: 20 }, (_, i) => `/repos/project/file-${i}.ts`) }), [decision()], { maxChars: 200 });
  assert.ok(packet.length > 200);
  assert.match(packet, /truncated by project packet at 200 chars/);
});

test("buildProjectPacket handles empty and missing projects", () => {
  const empty = buildProjectPacket(project({ roots: [], contextPaths: [], artifactPaths: [] }), []);
  assert.match(empty, /No linked folders/);
  assert.match(empty, /No context paths linked/);
  assert.match(empty, /No pinned memories/);
  assert.equal(buildProjectPacket(undefined, []), "No active Lodestone project.");
});

test("buildProjectPacket references paths without reading file contents", () => {
  const packet = buildProjectPacket(project({ contextPaths: ["/definitely/not/read/secret.md"] }), []);
  assert.match(packet, /\/definitely\/not\/read\/secret.md/);
  assert.doesNotMatch(packet, /secret file contents/i);
});
