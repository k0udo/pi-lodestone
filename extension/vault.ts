import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { VAULT_DIR, VAULT_KB_DIR, VAULT_MEMORY_DIR } from "./config.ts";
import type { Decision } from "./types.ts";

// Optional bridge to a Markdown vault directory (e.g. Obsidian). Disabled unless
// PI_MEMORY_VAULT_DIR points at an existing vault root, so the package never
// writes outside the memory store unless explicitly asked.

export function safeFilePart(text: string): string {
  return (text.split(/(?<=[.!?])\s+/)[0] ?? text)
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "memory";
}

export function yamlString(value: string): string {
  return JSON.stringify(value);
}

export function promotionFolder(decision: Decision): string {
  return decision.tags.some((t) => ["preference", "decision"].includes(t)) || decision.source === "manual" ? VAULT_MEMORY_DIR : VAULT_KB_DIR;
}

// Returns the vault-relative path written, or undefined when no vault is configured.
export async function writeVaultNote(decision: Decision, forcedFolder?: string): Promise<string | undefined> {
  if (!existsSync(VAULT_DIR)) return undefined;
  const folder = forcedFolder ?? promotionFolder(decision);
  const relPath = `${folder}/Lodestone - ${safeFilePart(decision.title)} - ${decision.id}.md`;
  const fullPath = join(VAULT_DIR, relPath);
  await mkdir(dirname(fullPath), { recursive: true });
  if (!existsSync(fullPath)) {
    const tags = [...new Set(["agent-memory", "pi-memory", ...decision.tags])].map((t) => t.replace(/[^A-Za-z0-9_/-]/g, "-"));
    const body = [
      "---",
      `title: ${yamlString(decision.title)}`,
      `created: ${decision.createdAt.slice(0, 10)}`,
      `updated: ${new Date().toISOString().slice(0, 10)}`,
      "tags:",
      ...tags.map((t) => `  - ${t}`),
      `pi_memory_id: ${yamlString(decision.id)}`,
      `pi_memory_project: ${yamlString(decision.project)}`,
      "---",
      `# ${decision.title}`,
      "",
      decision.text,
      "",
    ].join("\n");
    await writeFile(fullPath, body, "utf8");
  }
  return relPath;
}
