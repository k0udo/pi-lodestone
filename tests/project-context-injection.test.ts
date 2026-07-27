import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PROJECT_PACKET_INJECT } from "../extension/config.ts";
import { buildProjectPacket, joinContextBlocks } from "../extension/project-packet.ts";
import type { Decision, ProjectRecord, ProjectSessionRecord } from "../extension/types.ts";

function project(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id: "prj_lodestone",
    name: "pi-lodestone",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    roots: ["/repos/pi-lodestone"],
    contextPaths: ["/repos/pi-lodestone/docs/proposals/projects.md"],
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
    cwd: "/repos/pi-lodestone",
    project: "pi-lodestone",
    projectId: "prj_lodestone",
    source: "manual",
    title: "Use local package path",
    text: "Install the local checkout for fast Pi package testing.",
    tags: ["workflow"],
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
    updatedAt: "2026-01-03T00:00:00.000Z",
    title: "Project packet injection",
    decisionIds: [],
    artifactPaths: [],
    ...overrides,
  };
}

test("project packet injection remains disabled by default", () => {
  assert.equal(PROJECT_PACKET_INJECT, false);
});

test("disabled project packet path contributes no project block", () => {
  const packet = PROJECT_PACKET_INJECT ? buildProjectPacket(project(), [decision()], { sessions: [session()] }) : undefined;
  const context = joinContextBlocks([packet, "## Pi memory (verify)\n- [mem-1] Memory"]);
  assert.doesNotMatch(context, /## Project:/);
  assert.match(context, /## Pi memory \(verify\)/);
});

test("enabled-style project packet combines cleanly with lexical memory block", () => {
  const packet = buildProjectPacket(project(), [decision()], { sessions: [session()] });
  const memoryBlock = "## Pi memory (verify)\n- [mem-1] Memory";
  const context = joinContextBlocks([packet, memoryBlock]);
  assert.match(context, /^## Project: pi-lodestone \(verify\)/);
  assert.match(context, /\n\n---\n\n## Pi memory \(verify\)/);
  assert.match(context, /Project packet injection/);
});

test("no active project skips project packet but keeps lexical memory context", () => {
  const packet = undefined;
  const context = joinContextBlocks([packet, "## Pi memory (verify)\n- [mem-1] Memory"]);
  assert.equal(context, "## Pi memory (verify)\n- [mem-1] Memory");
});

test("project packet context is bounded before combination", () => {
  const packet = buildProjectPacket(project({ contextPaths: Array.from({ length: 30 }, (_, i) => `/repos/pi-lodestone/file-${i}.ts`) }), [], { maxChars: 180 });
  assert.match(packet, /truncated by project packet at 180 chars/);
  const context = joinContextBlocks([packet, "## Pi memory (verify)\n- [mem-1] Memory"]);
  assert.match(context, /## Pi memory \(verify\)/);
});
