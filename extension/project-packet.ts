import type { Decision, ProjectRecord } from "./types.ts";

export type ProjectPacketOptions = {
  maxChars?: number;
  includePinnedLimit?: number;
};

export const PROJECT_PACKET_DEFAULT_MAX_CHARS = 1_200;
export const PROJECT_PACKET_DEFAULT_PINNED_LIMIT = 8;

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

export function buildProjectPacket(project: ProjectRecord | undefined, decisions: Decision[], options: ProjectPacketOptions = {}) {
  if (!project) return "No active Lodestone project.";
  const maxChars = options.maxChars ?? PROJECT_PACKET_DEFAULT_MAX_CHARS;
  const pinnedLimit = options.includePinnedLimit ?? PROJECT_PACKET_DEFAULT_PINNED_LIMIT;
  const pinned = pinnedMemories(project, decisions, pinnedLimit);
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
    "Related sessions:",
    "- Session packet support is not enabled yet.",
  ];
  return capPacket(lines.join("\n"), maxChars);
}
