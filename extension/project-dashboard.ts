import { relative } from "node:path";
import type { Decision, ProjectRecord, ProjectRegistry, ProjectSessionRecord } from "./types.ts";

export type ProjectDashboardInput = {
  registry: ProjectRegistry;
  selected?: ProjectRecord;
  activeId?: string;
  cwd: string;
  decisions: Decision[];
  sessions?: ProjectSessionRecord[];
};

export function numbered(items: string[] | undefined, empty: string) {
  return items?.length ? items.map((item, i) => `${i + 1}. ${item}`) : [`- ${empty}`];
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function pathIsInsideRoot(path: string, root: string) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

function cwdState(selected: ProjectRecord | undefined, cwd: string) {
  if (!selected) return "No project selected";
  const root = selected.roots.find((candidate) => pathIsInsideRoot(cwd, candidate));
  return root ? `Inside linked folder: ${root}` : "cwd is outside linked folders";
}

function sessionLine(session: ProjectSessionRecord, i: number) {
  return `${i + 1}. ${session.updatedAt.slice(0, 10)} — ${session.title ?? session.summary ?? session.cwd}`;
}

export function projectDashboardLines(input: ProjectDashboardInput) {
  const { registry, selected, activeId, cwd, decisions, sessions = [] } = input;
  const projects = registry.projects.filter((p) => !p.archived);
  const pinned = selected ? decisions.filter((d) => !d.archived && d.important && d.projectId === selected.id) : [];
  const roots = selected?.roots ?? [];
  const contextPaths = [...(selected?.contextPaths ?? []), ...(selected?.artifactPaths ?? [])];
  return [
    selected ? `Project dashboard: ${selected.name}` : "Project dashboard",
    `cwd: ${cwd}`,
    `Status: ${selected ? `${selected.id === activeId ? "active" : "inactive"} · ${cwdState(selected, cwd)}` : "no project selected"}`,
    "",
    "Overview:",
    `- ${countLabel(projects.length, "project")}`,
    `- ${countLabel(roots.length, "linked folder")}`,
    `- ${countLabel(contextPaths.length, "context/artifact path")}`,
    `- ${countLabel(sessions.length, "recent session")}`,
    `- ${countLabel(pinned.length, "pinned memory", "pinned memories")}`,
    "",
    "Projects:",
    ...(projects.length ? projects.map((p, i) => {
      const isSelected = p.id === selected?.id;
      const isActive = p.id === activeId;
      return `${isSelected ? "▶ SELECTED" : "          "} ${isActive ? "*" : " "} ${i + 1}. ${p.name} [${p.id}]${isActive ? " active" : ""}`;
    }) : ["- No projects yet. Press n or run /project new <name>."]),
    "",
    selected ? `Selected: ${selected.name} (${selected.id})${selected.id === activeId ? " — active" : ""}` : "Selected: none",
    "Linked folders:",
    ...numbered(roots, "No folders linked. Press a or run /project root add [path]."),
    "Context / artifacts:",
    ...numbered(contextPaths, "No context paths linked. Press c or run /project context add <path>."),
    "Related sessions:",
    ...(sessions.length ? sessions.slice(0, 5).map(sessionLine) : ["- No related sessions indexed yet. They appear after working in this project."]),
    "Pinned memories:",
    ...(pinned.length ? pinned.slice(0, 8).map((d) => `- [${d.id}] ★ ${d.title}`) : ["- No pinned memories for this project."]),
    "",
    "Keys: ↑↓ browse · enter switch · n new · a add folder · r remove folder · c add context · x remove context · p packet · q close",
  ];
}

export function truncatePlain(line: string, width: number) {
  return line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`;
}

export function borderedLines(title: string, body: string[], width: number) {
  const safeWidth = Math.max(50, width);
  const innerWidth = safeWidth - 2;
  const label = ` ${truncatePlain(title, Math.max(1, innerWidth - 4))} `;
  const topFill = Math.max(0, innerWidth - label.length - 1);
  const top = `╭─${label}${"─".repeat(topFill)}╮`;
  const bottom = `╰${"─".repeat(innerWidth)}╯`;
  return [top, ...body.map((line) => `│${truncatePlain(line, innerWidth).padEnd(innerWidth)}│`), bottom];
}
