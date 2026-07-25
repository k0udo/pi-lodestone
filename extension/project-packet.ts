import type { Decision, ProjectRecord, ProjectSessionRecord } from "./types.ts";

export type ProjectPacketOptions = {
  maxChars?: number;
  includePinnedLimit?: number;
  sessions?: ProjectSessionRecord[];
  includeSessionLimit?: number;
};

export const PROJECT_PACKET_DEFAULT_MAX_CHARS = 1_200;
export const PROJECT_PACKET_DEFAULT_PINNED_LIMIT = 8;
export const PROJECT_PACKET_DEFAULT_SESSION_LIMIT = 3;

export function joinContextBlocks(blocks: Array<string | undefined>) {
  return blocks.map((block) => block?.trim()).filter(Boolean).join("\n\n---\n\n");
}

function listOrPlaceholder(items: string[] | undefined, placeholder: string) {
  return items?.length ? items.map((item) => `- ${item}`) : [`- ${placeholder}`];
}

function capPacket(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated by project packet at ${maxChars} chars]`;
}

function pinnedMemories(project: ProjectRecord, decisions: Decision[], limit: number) {
  return decisions
    .filter((d) => !d.archived && d.important && d.projectId === project.id)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

function recentSessions(project: ProjectRecord, sessions: ProjectSessionRecord[] | undefined, limit: number) {
  return (sessions ?? [])
    .filter((session) => session.projectId === project.id)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.startedAt) - Date.parse(a.startedAt))
    .slice(0, limit);
}

function renderSession(session: ProjectSessionRecord) {
  const label = session.title ?? session.summary ?? session.cwd;
  const summary = session.summary && session.summary !== label ? ` — ${session.summary.replace(/\s+/g, " ").slice(0, 140)}` : "";
  return `- ${session.updatedAt.slice(0, 10)} — ${label}${summary}`;
}

export function buildProjectPacket(project: ProjectRecord | undefined, decisions: Decision[], options: ProjectPacketOptions = {}) {
  if (!project) return "No active Lodestone project.";
  const maxChars = options.maxChars ?? PROJECT_PACKET_DEFAULT_MAX_CHARS;
  const pinnedLimit = options.includePinnedLimit ?? PROJECT_PACKET_DEFAULT_PINNED_LIMIT;
  const sessionLimit = options.includeSessionLimit ?? PROJECT_PACKET_DEFAULT_SESSION_LIMIT;
  const pinned = pinnedMemories(project, decisions, pinnedLimit);
  const sessions = recentSessions(project, options.sessions, sessionLimit);
  const lines = [
    `## Project: ${project.name} (verify)`,
    `Project ID: ${project.id}`,
    "",
    "Linked folders:",
    ...listOrPlaceholder(project.roots, "No linked folders."),
    "",
    "Context / artifact paths:",
    ...listOrPlaceholder([...(project.contextPaths ?? []), ...(project.artifactPaths ?? [])], "No context paths linked."),
    "",
    "Pinned memories:",
    ...(pinned.length ? pinned.map((d) => `- [${d.id}] ★ ${d.title}: ${d.summary ?? d.text.replace(/\s+/g, " ").slice(0, 180)}`) : ["- No pinned memories for this project."]),
    "",
    "Recent sessions:",
    ...(sessions.length ? sessions.map(renderSession) : ["- No related sessions indexed yet."]),
  ];
  return capPacket(lines.join("\n"), maxChars);
}
