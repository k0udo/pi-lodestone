import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MEMORY_DIR } from "./config.ts";
import { store } from "./store-instance.ts";

// Optional git checkpointing of the memory store. Never runs on the hot path —
// only on manual `/memory git …` actions or memory-mutating commands — so the
// local model never pays a git round-trip per turn.

const execFileAsync = promisify(execFile);

export type GitResult = { ok: boolean; stdout: string; stderr: string };

export async function runGit(cwd: string, args: string[]): Promise<GitResult> {
  await mkdir(cwd, { recursive: true });
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 1_000_000 });
    return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error: any) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

const MEMORY_GIT_IGNORE = [".lock/", "*.tmp", "injections.jsonl", "tool-usage.jsonl", "", "# injection / tool-usage logs are local-only analysis state", ""];

export async function ensureMemoryGit(): Promise<GitResult> {
  await store.ensure();
  await mkdir(MEMORY_DIR, { recursive: true });
  if (!(await isGitRepo(MEMORY_DIR))) {
    let init = await runGit(MEMORY_DIR, ["init", "-b", "main"]);
    if (!init.ok) init = await runGit(MEMORY_DIR, ["init"]);
    if (!init.ok) return init;
  }
  const ignorePath = join(MEMORY_DIR, ".gitignore");
  if (!existsSync(ignorePath)) await writeFile(ignorePath, MEMORY_GIT_IGNORE.join("\n"), "utf8");
  return { ok: true, stdout: "", stderr: "" };
}

export type CheckpointResult = { committed: boolean; pushed: boolean; message: string };

export async function memoryCheckpoint(reason: string): Promise<CheckpointResult> {
  const init = await ensureMemoryGit();
  if (!init.ok) return { committed: false, pushed: false, message: `git init failed: ${init.stderr}` };
  await runGit(MEMORY_DIR, ["add", "--all", "--", "."]);
  const diff = await runGit(MEMORY_DIR, ["diff", "--cached", "--quiet"]);
  if (diff.ok) return { committed: false, pushed: false, message: "memory git: clean" };
  const commit = await runGit(MEMORY_DIR, ["commit", "-m", `pi-memory: ${reason.slice(0, 160)}`]);
  if (!commit.ok) return { committed: false, pushed: false, message: `commit failed: ${commit.stderr}` };
  return { committed: true, pushed: false, message: commit.stdout.trim() || "committed" };
}

export async function memoryStatus(): Promise<string> {
  if (!(await isGitRepo(MEMORY_DIR))) return "memory store is not a git repository";
  const status = await runGit(MEMORY_DIR, ["status", "--short", "--branch"]);
  return status.ok ? status.stdout.trim() : status.stderr.trim();
}
