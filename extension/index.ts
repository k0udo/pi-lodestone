import { strict as assert } from "node:assert";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { Decision } from "./types.ts";
import { DecisionStore, defaultStoreConfig } from "./storage.ts";
import { buildTokenWeights, inferTags, projectName, projectRoot, sameProjectScope, scoreDecision, tokenize } from "./scoring.ts";
import { computeInjectionStats, computeToolUsageStats, logInjection, logToolUsage, readRecentInjections, readRecentToolUsage, renderInjectionStats, renderInjections, renderToolUsageStats } from "./injection-log.ts";
import { migrate } from "./migrate.ts";

const MEMORY_DIR = process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "memory");
const INJECTION_LOG_FILE = join(MEMORY_DIR, "injections.jsonl");
const TOOL_USAGE_LOG_FILE = join(MEMORY_DIR, "tool-usage.jsonl");
const OBSERVATIONS_LOG_FILE = join(MEMORY_DIR, "observations.jsonl");
const MAX_TEXT_CHARS = Number(process.env.PI_MEMORY_MAX_TEXT_CHARS ?? 4_000);
const AUTO_INJECT = (process.env.PI_MEMORY_AUTO_INJECT ?? "true") !== "false";
const AUTO_TURN_CAPTURE = (process.env.PI_MEMORY_AUTO_TURN_CAPTURE ?? "false") === "true";
const GLOBAL_AUTO_INJECT = (process.env.PI_MEMORY_GLOBAL_AUTO_INJECT ?? "false") === "true";
const INJECT_LIMIT = Number(process.env.PI_MEMORY_INJECT_LIMIT ?? 3);
const INJECT_MIN_SCORE = Number(process.env.PI_MEMORY_INJECT_MIN_SCORE ?? 8);
const INJECT_SNIPPET_CHARS = Number(process.env.PI_MEMORY_INJECT_SNIPPET_CHARS ?? 180);
const INJECT_QUERY_MAX_TOKENS = Number(process.env.PI_MEMORY_INJECT_QUERY_MAX_TOKENS ?? 32);
const INJECT_PLACEMENT = (process.env.PI_MEMORY_INJECT_PLACEMENT ?? "user").toLowerCase() === "system" ? "system" : "user";
const SEARCH_DEFAULT_LIMIT = Number(process.env.PI_MEMORY_SEARCH_DEFAULT_LIMIT ?? 5);
const SEARCH_SNIPPET_CHARS = Number(process.env.PI_MEMORY_SEARCH_SNIPPET_CHARS ?? 220);
const STALENESS_DEFAULT_DAYS = Number(process.env.PI_MEMORY_STALENESS_DAYS ?? 30);
const MEMORY_GET_MAX_OUTPUT_CHARS = Number(process.env.PI_MEMORY_GET_MAX_OUTPUT_CHARS ?? 10_000);
const UPDATE_USAGE_COUNTERS = (process.env.PI_MEMORY_UPDATE_USAGE_COUNTERS ?? "false") === "true";
const TURN_USER_MAX_CHARS = Number(process.env.PI_MEMORY_TURN_USER_MAX_CHARS ?? 1_200);
const TURN_ASSISTANT_MAX_CHARS = Number(process.env.PI_MEMORY_TURN_ASSISTANT_MAX_CHARS ?? 1_800);
// Optional bridge to a Markdown vault directory. Opt-in: set PI_MEMORY_VAULT_DIR
// to a vault root to enable `promote-to-kb`. Empty by default so the package
// never writes outside the memory store unless asked.
const VAULT_DIR = process.env.PI_MEMORY_VAULT_DIR ?? "";
const VAULT_MEMORY_DIR = process.env.PI_MEMORY_VAULT_MEMORY_DIR ?? "Agent/Memory";
const VAULT_KB_DIR = process.env.PI_MEMORY_VAULT_KB_DIR ?? "Agent/KB";

const execFileAsync = promisify(execFile);
const store = new DecisionStore(defaultStoreConfig(MEMORY_DIR));
const INJECTION_QUERY_STOP_WORDS = new Set([
  "again", "another", "assessment", "begin", "changes", "check", "closing", "commit", "complete",
  "complete-ness", "completeness", "designed", "detail", "enhancement", "enhancements", "explicit", "explict",
  "fix", "fixing", "follow", "function", "gap", "happen", "let", "make", "mind", "more", "nature",
  "needed", "next", "one", "operation", "pass", "perform", "plan", "push", "reload", "review", "should", "steps",
  "system", "then", "time", "valuable",
]);

function makeId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block: any) => {
      if (block?.type === "text") return block.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripPrivate(text: string) {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[private omitted]");
}

function maskSecrets(text: string) {
  return text
    .replace(/\b([A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Za-z0-9_]*?)\s*=\s*[^\s\n]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[redacted]");
}

function sanitize(text: string) {
  return maskSecrets(stripPrivate(text)).trim().slice(0, MAX_TEXT_CHARS);
}

function truncate(text: string, n: number) {
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function capOutput(text: string, maxChars: number) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated by memory-get at ${maxChars} chars; call again with fewer IDs or larger maxChars if needed]`;
}

function compactQuery(text: string, maxTokens: number) {
  return [...new Set(tokenize(text).filter((token) => !INJECTION_QUERY_STOP_WORDS.has(token)))]
    .slice(0, Math.max(1, maxTokens))
    .join(" ");
}

function applyUserPreamble(messages: any[], preamble: string) {
  if (!preamble) return messages;
  const next = [...messages];
  const idx = next.findLastIndex((message) => message?.role === "user");
  if (idx < 0) return messages;
  const message = { ...next[idx] };
  const prefix = `${preamble}\n\n## User request\n`;
  if (typeof message.content === "string") {
    message.content = message.content.startsWith(preamble) ? message.content : `${prefix}${message.content}`;
  } else if (Array.isArray(message.content)) {
    const content = [...message.content];
    const textIdx = content.findIndex((block) => block?.type === "text");
    if (textIdx >= 0) {
      const block = { ...content[textIdx] };
      const text = String(block.text ?? "");
      block.text = text.startsWith(preamble) ? text : `${prefix}${text}`;
      content[textIdx] = block;
    } else {
      content.unshift({ type: "text", text: prefix.trimEnd() });
    }
    message.content = content;
  }
  next[idx] = message;
  return next;
}

function excerpt(text: string, query: string | undefined, maxChars: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean;
  const terms = query ? [...new Set(tokenize(query))].sort((a, b) => b.length - a.length).slice(0, 12) : [];
  const lower = clean.toLowerCase();
  let best = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx >= 0 && (best < 0 || idx < best)) best = idx;
  }
  if (best < 0) return `${clean.slice(0, maxChars)}…`;
  const start = Math.max(0, Math.min(best - Math.floor(maxChars * 0.35), clean.length - maxChars));
  const end = Math.min(clean.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${clean.slice(start, end)}${end < clean.length ? "…" : ""}`;
}

function compact(decision: Decision, score?: number, query?: string, snippetChars = SEARCH_SNIPPET_CHARS) {
  return {
    id: decision.id,
    createdAt: decision.createdAt,
    project: decision.project,
    cwd: decision.cwd,
    source: decision.source,
    title: decision.title,
    tags: decision.tags,
    important: decision.important,
    archived: decision.archived,
    score,
    snippet: excerpt(decision.text, query, snippetChars),
  };
}

function renderCompactList(items: ReturnType<typeof compact>[]) {
  if (items.length === 0) return "No matching memories.";
  return items
    .map((r, i) => [
      `${i + 1}. [${r.id}] ${r.important ? "★ " : ""}${r.title}`,
      `   ${r.createdAt.slice(0, 10)} · ${r.project} · ${r.source}${r.archived ? " · archived" : ""} · score ${r.score ?? "n/a"}`,
      `   ${r.snippet}`,
    ].join("\n"))
    .join("\n\n");
}

type MemoryLike = Pick<Decision, "id" | "title" | "createdAt" | "updatedAt" | "text" | "archived" | "lastRetrievedAt" | "lastInjectedAt">;

function parseJsonLines(text: string): any[] {
  const rows: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Ignore corrupt log lines; staleness is advisory only.
    }
  }
  return rows;
}

async function readMemoryLikeEntries(fallback: Decision[]): Promise<MemoryLike[]> {
  if (!existsSync(OBSERVATIONS_LOG_FILE)) return fallback;
  const rows = parseJsonLines(await readFile(OBSERVATIONS_LOG_FILE, "utf8"));
  return rows
    .map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? row.summary ?? "Untitled memory"),
      createdAt: String(row.createdAt ?? row.timestamp ?? row.ts ?? ""),
      updatedAt: String(row.updatedAt ?? row.timestamp ?? row.ts ?? ""),
      text: String(row.text ?? ""),
      archived: row.archived === true || row.state === "archived",
      lastRetrievedAt: typeof row.lastRetrievedAt === "string" ? row.lastRetrievedAt : undefined,
      lastInjectedAt: typeof row.lastInjectedAt === "string" ? row.lastInjectedAt : undefined,
    }))
    .filter((row) => row.id && Number.isFinite(Date.parse(row.createdAt)));
}

async function readLastReferences(): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const note = (id: unknown, ts: unknown) => {
    if (typeof id !== "string" || typeof ts !== "string" || !Number.isFinite(Date.parse(ts))) return;
    const prev = refs.get(id);
    if (!prev || Date.parse(ts) > Date.parse(prev)) refs.set(id, ts);
  };
  if (existsSync(TOOL_USAGE_LOG_FILE)) {
    for (const row of parseJsonLines(await readFile(TOOL_USAGE_LOG_FILE, "utf8"))) {
      for (const id of row.resultIds ?? row.returnedIds ?? row.requestedIds ?? row.details?.resultIds ?? row.details?.returnedIds ?? []) note(id, row.ts);
    }
  }
  if (existsSync(INJECTION_LOG_FILE)) {
    for (const row of parseJsonLines(await readFile(INJECTION_LOG_FILE, "utf8"))) {
      for (const result of row.results ?? []) note(result?.id, row.ts);
    }
  }
  return refs;
}

function latestIso(...values: (string | undefined)[]) {
  return values.filter((v): v is string => Boolean(v) && Number.isFinite(Date.parse(v))).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

async function staleMemories(days: number, fallback: Decision[]) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const [entries, refs] = await Promise.all([readMemoryLikeEntries(fallback), readLastReferences()]);
  return entries
    .filter((entry) => !entry.archived && Date.parse(entry.createdAt) < cutoffMs)
    .map((entry) => {
      const lastReferenced = latestIso(refs.get(entry.id), entry.lastRetrievedAt, entry.lastInjectedAt);
      return { entry, ageDays: Math.floor((Date.now() - Date.parse(entry.createdAt)) / (24 * 60 * 60 * 1000)), lastReferenced };
    })
    .filter((row) => !row.lastReferenced || Date.parse(row.lastReferenced) < cutoffMs)
    .sort((a, b) => (Date.parse(a.lastReferenced ?? "1970-01-01") - Date.parse(b.lastReferenced ?? "1970-01-01")) || Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt))
    .slice(0, 20);
}

function renderStaleness(rows: Awaited<ReturnType<typeof staleMemories>>, days: number) {
  if (rows.length === 0) return `No stale memories older than ${days} days.`;
  return [
    `Stale memory candidates (> ${days} days old, max 20; review-only):`,
    ...rows.map(({ entry, ageDays, lastReferenced }, i) => `${i + 1}. [${entry.id}] ${entry.title} · age ${ageDays}d · last referenced ${lastReferenced ? lastReferenced.slice(0, 10) : "unknown"}`),
  ].join("\n");
}

const DEDUP_STOP_WORDS = new Set([
  "about", "after", "again", "agent", "because", "before", "current", "decision", "decided", "default", "during", "entry", "implementation", "memory", "pi", "project", "should", "summary", "that", "then", "there", "these", "this", "using", "when", "with", "workflow",
]);

function significantWords(text: string) {
  return [...new Set(tokenize(text).filter((token) => token.length >= 4 && !DEDUP_STOP_WORDS.has(token)))];
}

function overlapRatio(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const bSet = new Set(b);
  const shared = a.filter((token) => bSet.has(token)).length;
  return shared / Math.min(a.length, b.length);
}

function findPotentialDuplicate(title: string, text: string, existing: Decision[], threshold = 0.6) {
  const newTitleWords = significantWords(title);
  const newBodyWords = significantWords(`${title} ${text.slice(0, 200)}`);
  let best: { decision: Decision; score: number } | undefined;
  for (const decision of existing) {
    if (decision.archived) continue;
    const titleScore = overlapRatio(newTitleWords, significantWords(decision.title));
    const bodyScore = overlapRatio(newBodyWords, significantWords(`${decision.title} ${decision.text.slice(0, 200)}`));
    const score = Math.max(titleScore, bodyScore);
    if (score > (best?.score ?? 0)) best = { decision, score };
  }
  return best && best.score > threshold ? best : undefined;
}

function renderFull(decision: Decision) {
  return [
    `[${decision.id}] ${decision.important ? "★ " : ""}${decision.title}`,
    `${decision.createdAt} · ${decision.project} · ${decision.cwd} · ${decision.source}${decision.archived ? " · archived" : ""}`,
    decision.tags.length ? `Tags: ${decision.tags.join(", ")}` : undefined,
    decision.kbPath ? `KB: ${decision.kbPath}` : undefined,
    decision.supersededBy ? `Superseded by: ${decision.supersededBy}` : undefined,
    decision.supersedes?.length ? `Supersedes: ${decision.supersedes.join(", ")}` : undefined,
    decision.conflictsWith?.length ? `Conflicts with: ${decision.conflictsWith.join(", ")}` : undefined,
    "",
    decision.text,
  ].filter(Boolean).join("\n");
}

async function search(query: string, options: { limit: number; cwd?: string; projectOnly?: boolean; forInjection?: boolean; minScore?: number; includeArchived?: boolean; snippetChars?: number }) {
  const all = await store.all();
  const min = options.minScore ?? 1;
  const candidates = all
    .filter((d) => options.includeArchived || !d.archived)
    .filter((d) => !options.projectOnly || !options.cwd || sameProjectScope(d.cwd, options.cwd));
  const tokenWeights = buildTokenWeights(candidates);
  return candidates
    .map((d) => ({ d, score: scoreDecision(d, query, options.cwd, { forInjection: options.forInjection, tokenWeights }) }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score || Date.parse(b.d.createdAt) - Date.parse(a.d.createdAt))
    .slice(0, options.limit)
    .map((x) => compact(x.d, x.score, query, options.snippetChars ?? SEARCH_SNIPPET_CHARS));
}

async function bumpUse(ids: string[], usage: "retrieved" | "injected") {
  if (!UPDATE_USAGE_COUNTERS) return;
  await store.bumpUse(ids, usage);
}

async function recordToolUsage(tool: string, cwd: string, resultCount: number, extra: Record<string, unknown> = {}) {
  await logToolUsage(TOOL_USAGE_LOG_FILE, {
    ts: new Date().toISOString(),
    tool,
    cwd,
    project: projectName(cwd),
    resultCount,
    ...extra,
  }).catch(() => undefined);
}

async function runGit(cwd: string, args: string[]) {
  await mkdir(cwd, { recursive: true });
  try {
    const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 1_000_000 });
    return { ok: true, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") };
  } catch (error: any) {
    return { ok: false, stdout: String(error?.stdout ?? ""), stderr: String(error?.stderr ?? error?.message ?? "") };
  }
}

async function isGitRepo(cwd: string) {
  return (await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).stdout.trim() === "true";
}

const MEMORY_GIT_IGNORE = [".lock/", "*.tmp", "injections.jsonl", "tool-usage.jsonl", "", "# injection / tool-usage logs are local-only analysis state", ""];

async function ensureMemoryGit() {
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

async function memoryCheckpoint(reason: string) {
  const init = await ensureMemoryGit();
  if (!init.ok) return { committed: false, pushed: false, message: `git init failed: ${init.stderr}` };
  await runGit(MEMORY_DIR, ["add", "--all", "--", "."]);
  const diff = await runGit(MEMORY_DIR, ["diff", "--cached", "--quiet"]);
  if (diff.ok) return { committed: false, pushed: false, message: "memory git: clean" };
  const commit = await runGit(MEMORY_DIR, ["commit", "-m", `pi-memory: ${reason.slice(0, 160)}`]);
  if (!commit.ok) return { committed: false, pushed: false, message: `commit failed: ${commit.stderr}` };
  return { committed: true, pushed: false, message: commit.stdout.trim() || "committed" };
}

async function memoryStatus() {
  if (!(await isGitRepo(MEMORY_DIR))) return "memory store is not a git repository";
  const status = await runGit(MEMORY_DIR, ["status", "--short", "--branch"]);
  return status.ok ? status.stdout.trim() : status.stderr.trim();
}

function safeFilePart(text: string) {
  return (text.split(/(?<=[.!?])\s+/)[0] ?? text)
    .replace(/[\\/:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "memory";
}

function yamlString(value: string) {
  return JSON.stringify(value);
}

function promotionFolder(decision: Decision) {
  return decision.tags.some((t) => ["preference", "decision"].includes(t)) || decision.source === "manual" ? VAULT_MEMORY_DIR : VAULT_KB_DIR;
}

// Promotion is an optional bridge to a Markdown vault directory. If the vault
// root is absent we skip rather than mkdir a stray tree, so the store stays
// self-contained when no vault is configured. Returns undefined when missing.
async function writeVaultNote(decision: Decision, forcedFolder?: string): Promise<string | undefined> {
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

function compactTurnText(messages: any[]) {
  const userText = messages.filter((m) => m.role === "user").map((m) => textFromContent(m.content)).filter(Boolean).at(-1) ?? "";
  const assistantText = messages.filter((m) => m.role === "assistant").map((m) => textFromContent(m.content)).filter(Boolean).at(-1) ?? "";
  return {
    userText,
    assistantText,
    text: sanitize([
      userText && `User:\n${truncate(userText, TURN_USER_MAX_CHARS)}`,
      assistantText && `Assistant:\n${truncate(assistantText, TURN_ASSISTANT_MAX_CHARS)}`,
    ].filter(Boolean).join("\n\n")),
  };
}

function hasDurableSignal(text: string) {
  return /\b(decision|decided|remember|preference|prefer|always|never|do not|don't|root cause|workflow|architecture|migration|policy|target state|review gate|semi-automatic)\b/i.test(text);
}

function decisionStatementFromTurn(text: string): string | undefined {
  const candidates = text
    .split(/\n+/)
    .map((line) => line.replace(/^(User|Assistant):\s*/i, "").trim())
    .filter((line) => line.length >= 30 && line.length <= 500)
    .filter((line) => /\b(decision|decided|prefer|preference|always|never|do not|don't|should|target state|architecture|workflow|review gate|semi-automatic|use .+ because)\b/i.test(line));
  return candidates[0]?.slice(0, 500);
}

function runSelfTests() {
  const tests: { name: string; run: () => void }[] = [];
  const add = (name: string, run: () => void) => tests.push({ name, run });

  add("sanitize masks secrets and strips private blocks", () => {
    const text = sanitize("keep <private>secret-token</private> API_KEY=abc Bearer abc.def sk-abcdefghijklmnop1234567");
    assert(!text.includes("secret-token"));
    assert(text.includes("[private omitted]"));
    assert(text.includes("API_KEY=[redacted]"));
    assert(text.includes("Bearer [redacted]"));
    assert(text.includes("sk-[redacted]"));
  });

  add("project root collapses nested repo paths", () => {
    assert.equal(projectRoot("/repos/example/macos/pi"), "/repos/example");
    assert.equal(projectName("/repos/example/macos/pi"), "example");
    assert.equal(sameProjectScope("/repos/example/macos/pi", "/repos/example"), true);
  });

  add("inferTags surfaces decision and workflow tags from body", () => {
    const tags = inferTags("Decision", "We decided to use git checkpoints.", ["manual"]);
    assert(tags.includes("decision"));
    assert(tags.includes("manual"));
  });

  add("decision statement extraction prefers durable phrasing", () => {
    const text = "User:\nLet's keep memory recovery semi-automatic with a human review gate.";
    assert(decisionStatementFromTurn(text)?.includes("semi-automatic"));
  });

  add("durable signal detector accepts decisions and skips chatter", () => {
    assert.equal(hasDurableSignal("we decided to ship phase 4"), true);
    assert.equal(hasDurableSignal("what time is it"), false);
  });

  add("user preamble injection prefixes the latest user message only", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "old request" }], timestamp: 1 },
      { role: "assistant", content: [], timestamp: 2 },
      { role: "user", content: [{ type: "text", text: "new request" }], timestamp: 3 },
    ];
    const next = applyUserPreamble(messages, "## Pi memory (verify)\n- [m1] Memory") as any[];
    assert.equal((messages[2].content[0] as any).text, "new request");
    assert.equal((next[0].content[0] as any).text, "old request");
    assert.match((next[2].content[0] as any).text, /^## Pi memory \(verify\)/);
    assert.match((next[2].content[0] as any).text, /## User request\nnew request/);
  });

  add("dedup detects close lexical duplicates but skips different memories", () => {
    const base: Decision = {
      id: "m1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/project",
      project: "project",
      source: "manual",
      title: "Pi Memory staleness review cadence",
      text: "Run stale memory review quarterly and keep it non destructive.",
      tags: [],
      important: false,
      archived: false,
      retrievalCount: 0,
      injectionCount: 0,
    };
    assert.equal(findPotentialDuplicate("Memory staleness review cadence", "Review stale memories quarterly without deleting them.", [base])?.decision.id, "m1");
    assert.equal(findPotentialDuplicate("Secret rotation policy", "Rotate API keys through the secrets CLI.", [base]), undefined);
  });

  const failures: string[] = [];
  for (const t of tests) {
    try {
      t.run();
    } catch (error) {
      failures.push(`${t.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { passed: tests.length - failures.length, failed: failures.length, failures };
}

async function projectEnabled(cwd: string) {
  const settings = await store.readSettings();
  return !(settings.disabledProjects ?? []).includes(cwd);
}

export default function (pi: ExtensionAPI) {
  let pendingMemoryPreamble: string | undefined;

  pi.registerTool({
    name: "memory-search",
    label: "Memory Search",
    description: "Search Pi persistent memory (curated decisions/preferences/workflows). Returns compact entries with IDs.",
    promptSnippet: "Search Pi memory for prior decisions and durable context",
    promptGuidelines: [
      "Use memory-search first when looking for prior project decisions, recurring workflows, or remembered context.",
      "After memory-search returns IDs, use memory-get for full bodies only on the IDs you need.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Natural language or keyword search query" }),
      limit: Type.Optional(Type.Number({ description: "Maximum results. Defaults to 5.", minimum: 1, maximum: 50 })),
      projectOnly: Type.Optional(Type.Boolean({ description: "Restrict to current cwd/project. Defaults to false." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await search(params.query, { limit: params.limit ?? SEARCH_DEFAULT_LIMIT, cwd: ctx.cwd, projectOnly: params.projectOnly ?? false });
      await bumpUse(results.map((r) => r.id), "retrieved");
      await recordToolUsage("memory-search", ctx.cwd, results.length, { query: params.query, resultIds: results.map((r) => r.id) });
      return { content: [{ type: "text" as const, text: renderCompactList(results) }], details: { query: params.query, resultIds: results.map((r) => r.id) } };
    },
  });

  pi.registerTool({
    name: "memory-get",
    label: "Memory Get",
    description: "Fetch full persistent memory entries by ID. Batch multiple IDs when possible.",
    promptSnippet: "Fetch full Pi memory entries by ID",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ description: "Decision IDs returned by memory-search" }), { maxItems: 20 }),
      maxChars: Type.Optional(Type.Number({ description: "Maximum output characters. Defaults to 10000.", minimum: 500, maximum: 50000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const ids = params.ids.slice(0, 20);
      const maxChars = clampNumber(params.maxChars, MEMORY_GET_MAX_OUTPUT_CHARS, 500, 50_000);
      const all = await store.all();
      const byId = new Map(all.map((d) => [d.id, d]));
      const found = ids.map((id) => byId.get(id)).filter((d): d is Decision => Boolean(d));
      await bumpUse(found.map((d) => d.id), "retrieved");
      await recordToolUsage("memory-get", ctx.cwd, found.length, { requestedIds: ids, returnedIds: found.map((d) => d.id) });
      const text = found.length ? capOutput(found.map(renderFull).join("\n\n---\n\n"), maxChars) : "No matching memory IDs.";
      return { content: [{ type: "text" as const, text }], details: { requestedIds: ids, returnedIds: found.map((d) => d.id), maxChars } };
    },
  });

  pi.registerTool({
    name: "memory-add",
    label: "Memory Add",
    description: "Add a durable decision, preference, workflow, or fix to Pi persistent memory.",
    promptSnippet: "Persist a durable decision or preference to Pi memory",
    promptGuidelines: ["Use memory-add when the user asks you to remember something or when a durable project decision should survive future sessions."],
    parameters: Type.Object({
      title: Type.String({ description: "Short title" }),
      text: Type.String({ description: "Memory body. Content inside <private> tags is omitted." }),
      tags: Type.Optional(Type.Array(Type.String({ description: "Optional tags" }))),
      important: Type.Optional(Type.Boolean({ description: "Pin as important; boosts retrieval score." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const now = new Date().toISOString();
      const title = sanitize(params.title);
      const text = sanitize(params.text);
      const decision: Decision = {
        id: makeId(),
        createdAt: now,
        updatedAt: now,
        cwd: ctx.cwd,
        project: projectName(ctx.cwd),
        source: "manual",
        title,
        text,
        tags: inferTags(title, text, params.tags ?? []),
        important: params.important ?? false,
        archived: false,
        retrievalCount: 0,
        injectionCount: 0,
      };
      const duplicate = findPotentialDuplicate(title, text, await store.all());
      await store.add(decision);
      await recordToolUsage("memory-add", ctx.cwd, 1);
      const checkpoint = await memoryCheckpoint(`add ${decision.id}`);
      const duplicateWarning = duplicate ? `Potential duplicate: [${duplicate.decision.id}] ${duplicate.decision.title}` : undefined;
      return { content: [{ type: "text" as const, text: [duplicateWarning, `Remembered [${decision.id}] ${decision.title}`, checkpoint.message].filter(Boolean).join("\n") }], details: { id: decision.id, important: decision.important, potentialDuplicateId: duplicate?.decision.id } };
    },
  });

  pi.registerCommand("memory", {
    description: "Manage Pi persistent memory: stats|health|self-test|path|search <q>|recent [n]|staleness [days]|add|archive|active|important|promote-to-kb|extract-decisions|summarize-session|why|why-stats|tool-stats|git status|init|checkpoint|push|supersede|conflict|disable-current|enable-current|migrate",
    handler: async (args, ctx) => {
      const [sub, ...rest] = args.trim().split(/\s+/);
      const all = await store.all();

      if (!sub || sub === "stats") {
        const active = all.filter((d) => !d.archived);
        const inProject = active.filter((d) => sameProjectScope(d.cwd, ctx.cwd));
        const important = active.filter((d) => d.important);
        ctx.ui.notify(`Pi memory: ${active.length} active (${inProject.length} in project, ${important.length} pinned). Store: ${store.config.decisionsPath}`, "info");
        return;
      }

      if (sub === "path") {
        ctx.ui.notify(`Decisions: ${store.config.decisionsPath}\nSettings: ${store.config.settingsPath}`, "info");
        return;
      }

      if (sub === "self-test") {
        const result = runSelfTests();
        const lines = [`Pi memory self-test: ${result.passed} passed, ${result.failed} failed`, ...result.failures.map((f) => `FAIL ${f}`)];
        ctx.ui.setWidget("pi-memory", lines, { placement: "belowEditor" });
        ctx.ui.notify(lines[0], result.failed ? "error" : "success");
        return;
      }

      if (sub === "health") {
        const selfTest = runSelfTests();
        const active = all.filter((d) => !d.archived);
        const archived = all.length - active.length;
        const memoryGit = await memoryStatus();
        const ok = selfTest.failed === 0;
        const lines = [
          `Pi memory health: ${ok ? "OK" : "ATTENTION"}`,
          `Self-test: ${selfTest.passed} passed, ${selfTest.failed} failed`,
          `Decisions: ${active.length} active, ${archived} archived`,
          `Pinned (important): ${active.filter((d) => d.important).length}`,
          `Store: ${store.config.decisionsPath}`,
          "Memory git:",
          memoryGit || "clean or unavailable",
        ];
        ctx.ui.setWidget("pi-memory", lines, { placement: "belowEditor" });
        ctx.ui.notify(lines[0], ok ? "success" : "warning");
        return;
      }

      if (sub === "recent") {
        const limit = Number(rest[0] ?? 10);
        const recent = [...all].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit).map((d) => compact(d));
        ctx.ui.setWidget("pi-memory", renderCompactList(recent).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "staleness") {
        const days = clampNumber(Number(rest[0]), STALENESS_DEFAULT_DAYS, 1, 3650);
        const rows = await staleMemories(days, all);
        ctx.ui.setWidget("pi-memory", renderStaleness(rows, days).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "search") {
        const query = rest.join(" ");
        const results = await search(query, { limit: SEARCH_DEFAULT_LIMIT, cwd: ctx.cwd, projectOnly: false });
        await bumpUse(results.map((r) => r.id), "retrieved");
        ctx.ui.setWidget("pi-memory", renderCompactList(results).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "add") {
        const idx = rest.indexOf("--");
        const title = idx >= 0 ? rest.slice(0, idx).join(" ") : rest.slice(0, 1).join(" ");
        const body = idx >= 0 ? rest.slice(idx + 1).join(" ") : rest.slice(1).join(" ");
        if (!title || !body) {
          ctx.ui.notify("Usage: /memory add <title> -- <body>", "warning");
          return;
        }
        const now = new Date().toISOString();
        const decision: Decision = {
          id: makeId(),
          createdAt: now,
          updatedAt: now,
          cwd: ctx.cwd,
          project: projectName(ctx.cwd),
          source: "manual",
          title: sanitize(title),
          text: sanitize(body),
          tags: inferTags(title, body, []),
          important: false,
          archived: false,
          retrievalCount: 0,
          injectionCount: 0,
        };
        const duplicate = findPotentialDuplicate(decision.title, decision.text, all);
        if (duplicate) ctx.ui.notify(`Potential duplicate: [${duplicate.decision.id}] ${duplicate.decision.title}`, "warning");
        await store.add(decision);
        const checkpoint = await memoryCheckpoint(`add ${decision.id}`);
        ctx.ui.notify(`Added [${decision.id}] ${decision.title}. ${checkpoint.message}`, "success");
        return;
      }

      if (["archive", "active", "important", "unimportant"].includes(sub)) {
        const ids = rest.filter(Boolean);
        if (ids.length === 0) {
          ctx.ui.notify(`Usage: /memory ${sub} <id...>`, "warning");
          return;
        }
        let changed = 0;
        for (const id of ids) {
          const patch =
            sub === "archive" ? { archived: true } :
            sub === "active" ? { archived: false } :
            sub === "important" ? { important: true } :
            { important: false };
          const next = await store.patch(id, patch);
          if (next) changed += 1;
        }
        const checkpoint = await memoryCheckpoint(`${sub} ${changed} memories`);
        ctx.ui.notify(`${sub}: ${changed}/${ids.length} updated. ${checkpoint.message}`, changed ? "success" : "warning");
        return;
      }

      if (sub === "promote-to-kb") {
        const ids = rest.filter((item) => item && !item.startsWith("--"));
        const forcedFolder = rest.includes("--memory") ? VAULT_MEMORY_DIR : rest.includes("--kb") ? VAULT_KB_DIR : undefined;
        if (ids.length === 0) {
          ctx.ui.notify("Usage: /memory promote-to-kb <id...> [--memory|--kb]", "warning");
          return;
        }
        const lines: string[] = [];
        let changed = 0;
        for (const id of ids) {
          const decision = await store.byId(id);
          if (!decision) {
            lines.push(`[${id}] not found`);
            continue;
          }
          const path = await writeVaultNote(decision, forcedFolder);
          if (!path) {
            lines.push(`[${id}] vault not found (${VAULT_DIR}); set PI_MEMORY_VAULT_DIR to enable promotion`);
            continue;
          }
          await store.patch(id, { kbPath: path, important: true });
          changed += 1;
          lines.push(`[${id}] promoted → ${path}`);
        }
        const checkpoint = await memoryCheckpoint(`promote-to-kb ${changed} memories`);
        ctx.ui.setWidget("pi-memory", lines.concat([`Updated ${changed}/${ids.length}.`, checkpoint.message]), { placement: "belowEditor" });
        return;
      }

      if (sub === "extract-decisions") {
        const apply = rest.includes("--apply") || rest.includes("apply");
        const numeric = rest.find((item) => /^\d+$/.test(item));
        const limit = Number(numeric ?? 10);
        const branch = ctx.sessionManager.getBranch();
        const candidates: { statement: string; userText: string; assistantText: string }[] = [];
        for (let i = 0; i < branch.length; i++) {
          const entry = branch[i];
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          const window = branch.slice(Math.max(0, i - 1), i + 1).map((e) => (e.type === "message" ? e.message : undefined)).filter(Boolean);
          const { userText, assistantText, text } = compactTurnText(window);
          const statement = decisionStatementFromTurn(text);
          if (statement) candidates.push({ statement, userText, assistantText });
        }
        const seen = new Set<string>();
        const unique = candidates.filter((c) => {
          const key = c.statement.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        }).slice(0, limit);
        const lines = unique.map((c, i) => `${i + 1}. ${c.statement}`);
        if (!apply) {
          ctx.ui.setWidget("pi-memory", (lines.length ? lines : ["No decision extraction candidates in this session."]).concat(["Dry run. Add --apply to persist."]), { placement: "belowEditor" });
          return;
        }
        const createdIds: string[] = [];
        for (const c of unique) {
          const now = new Date().toISOString();
          const decision: Decision = {
            id: makeId(),
            createdAt: now,
            updatedAt: now,
            cwd: ctx.cwd,
            project: projectName(ctx.cwd),
            source: "extracted",
            title: sanitize(c.statement.split(/(?<=[.!?])\s+/)[0]?.slice(0, 90) || "Extracted decision"),
            text: sanitize(c.statement),
            tags: inferTags(c.statement, c.statement, ["decision", "extracted"]),
            important: false,
            archived: false,
            retrievalCount: 0,
            injectionCount: 0,
          };
          await store.add(decision);
          createdIds.push(decision.id);
        }
        const checkpoint = await memoryCheckpoint(`extract-decisions added ${createdIds.length}`);
        ctx.ui.setWidget("pi-memory", lines.concat([`Created ${createdIds.length} extracted decisions.`, checkpoint.message]), { placement: "belowEditor" });
        return;
      }

      if (sub === "summarize-session") {
        const apply = rest.includes("--apply") || rest.includes("apply");
        const branch = ctx.sessionManager.getBranch();
        const userPrompts: string[] = [];
        const assistantOutcomes: string[] = [];
        const tools = new Map<string, number>();
        for (const entry of branch) {
          const message = entry.type === "message" ? entry.message : undefined;
          if (!message) continue;
          if (message.role === "user") userPrompts.push(textFromContent(message.content).replace(/\s+/g, " ").slice(0, 200));
          if (message.role === "assistant") {
            const text = textFromContent(message.content).replace(/\s+/g, " ").slice(0, 240);
            if (text) assistantOutcomes.push(text);
            for (const block of Array.isArray(message.content) ? message.content : []) {
              if (block?.type === "toolCall") tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
            }
          }
        }
        const title = `Session summary: ${projectName(ctx.cwd)} ${new Date().toISOString().slice(0, 10)}`;
        const text = sanitize([
          `# ${title}`,
          "",
          "## Recent user goals",
          ...userPrompts.slice(-6).map((p) => `- ${p}`),
          "",
          "## Recent assistant outcomes",
          ...assistantOutcomes.slice(-6).map((p) => `- ${p}`),
          "",
          "## Tool activity",
          ...[...tools.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([name, count]) => `- ${name}: ${count}`),
        ].join("\n"));
        if (!apply) {
          ctx.ui.setWidget("pi-memory", text.split("\n").concat(["", "Dry run. Add --apply to persist + write vault note."]), { placement: "belowEditor" });
          return;
        }
        const now = new Date().toISOString();
        const decision: Decision = {
          id: makeId(),
          createdAt: now,
          updatedAt: now,
          cwd: ctx.cwd,
          project: projectName(ctx.cwd),
          source: "manual",
          title,
          text,
          tags: inferTags(title, text, ["session-summary", "workflow"]),
          important: false,
          archived: false,
          retrievalCount: 0,
          injectionCount: 0,
        };
        await store.add(decision);
        const path = await writeVaultNote(decision, VAULT_MEMORY_DIR);
        if (path) await store.patch(decision.id, { kbPath: path });
        const checkpoint = await memoryCheckpoint(`summarize-session ${decision.id}`);
        const noteLine = path ? `Saved [${decision.id}] → ${path}` : `Saved [${decision.id}] (memory only; set PI_MEMORY_VAULT_DIR to also write a vault note)`;
        ctx.ui.setWidget("pi-memory", [noteLine, checkpoint.message], { placement: "belowEditor" });
        return;
      }

      if (sub === "why") {
        const limit = Math.max(1, Math.min(20, Number(rest[0] ?? 1) || 1));
        const records = await readRecentInjections(INJECTION_LOG_FILE, limit);
        ctx.ui.setWidget("pi-memory", renderInjections(records).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "why-stats") {
        const limit = Math.max(10, Math.min(10_000, Number(rest[0] ?? 500) || 500));
        const records = await readRecentInjections(INJECTION_LOG_FILE, limit);
        ctx.ui.setWidget("pi-memory", renderInjectionStats(computeInjectionStats(records)).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "tool-stats") {
        const limit = Math.max(10, Math.min(10_000, Number(rest[0] ?? 500) || 500));
        const records = await readRecentToolUsage(TOOL_USAGE_LOG_FILE, limit);
        ctx.ui.setWidget("pi-memory", renderToolUsageStats(computeToolUsageStats(records)).split("\n"), { placement: "belowEditor" });
        return;
      }

      if (sub === "git") {
        const action = rest[0] ?? "status";
        if (action === "init") {
          const init = await ensureMemoryGit();
          const ck = init.ok ? await memoryCheckpoint("initial snapshot") : undefined;
          ctx.ui.notify(init.ok ? `Memory git initialized. ${ck?.message ?? ""}` : `Init failed: ${init.stderr}`, init.ok ? "success" : "error");
          return;
        }
        if (action === "checkpoint") {
          const message = rest.slice(1).join(" ") || "manual checkpoint";
          const ck = await memoryCheckpoint(message);
          ctx.ui.notify(ck.message, ck.committed ? "success" : "info");
          return;
        }
        if (action === "push") {
          const remotes = await runGit(MEMORY_DIR, ["remote"]);
          if (!remotes.ok || !remotes.stdout.split("\n").includes("origin")) {
            ctx.ui.notify("No 'origin' remote configured on memory store.", "warning");
            return;
          }
          const push = await runGit(MEMORY_DIR, ["push", "-u", "origin", "main"]);
          ctx.ui.notify(push.ok ? push.stdout || "Memory git pushed." : `Push failed: ${push.stderr}`, push.ok ? "success" : "error");
          return;
        }
        if (action === "status") {
          const status = await memoryStatus();
          const lastLog = await runGit(MEMORY_DIR, ["log", "-1", "--oneline"]);
          ctx.ui.setWidget("pi-memory", [
            `Memory git (${MEMORY_DIR})`,
            status,
            lastLog.ok ? `Last commit: ${lastLog.stdout.trim()}` : "No commits yet",
          ], { placement: "belowEditor" });
          return;
        }
        ctx.ui.notify("Usage: /memory git status|init|checkpoint [msg]|push", "warning");
        return;
      }

      if (sub === "supersede") {
        const [oldId, newId] = rest;
        if (!oldId || !newId || oldId === newId) {
          ctx.ui.notify("Usage: /memory supersede <old-id> <new-id>", "warning");
          return;
        }
        const oldDecision = await store.byId(oldId);
        const newDecision = await store.byId(newId);
        if (!oldDecision || !newDecision) {
          ctx.ui.notify("Both memory IDs must exist.", "warning");
          return;
        }
        await store.patch(oldId, { supersededBy: newId });
        await store.patch(newId, { supersedes: [...new Set([...(newDecision.supersedes ?? []), oldId])] });
        const checkpoint = await memoryCheckpoint(`supersede ${oldId} by ${newId}`);
        ctx.ui.notify(`Marked ${oldId} superseded by ${newId}. ${checkpoint.message}`, "success");
        return;
      }

      if (sub === "conflict") {
        const [id, ...others] = rest;
        if (!id || others.length === 0) {
          ctx.ui.notify("Usage: /memory conflict <id> <other-id...>", "warning");
          return;
        }
        const target = await store.byId(id);
        const peers = (await Promise.all(others.map((other) => store.byId(other)))).filter(Boolean) as Decision[];
        if (!target || peers.length !== others.length) {
          ctx.ui.notify("All memory IDs must exist.", "warning");
          return;
        }
        const targetConflicts = new Set([...(target.conflictsWith ?? []), ...peers.map((peer) => peer.id)]);
        await store.patch(id, { conflictsWith: [...targetConflicts].sort() });
        for (const peer of peers) {
          await store.patch(peer.id, { conflictsWith: [...new Set([...(peer.conflictsWith ?? []), id])].sort() });
        }
        const checkpoint = await memoryCheckpoint(`conflict ${id} ${others.join(" ")}`);
        ctx.ui.notify(`Marked conflicts for ${id}. ${checkpoint.message}`, "success");
        return;
      }

      if (sub === "disable-current" || sub === "enable-current") {
        const settings = await store.readSettings();
        const disabled = new Set(settings.disabledProjects ?? []);
        if (sub === "disable-current") disabled.add(ctx.cwd);
        else disabled.delete(ctx.cwd);
        await store.writeSettings({ ...settings, disabledProjects: [...disabled].sort() });
        ctx.ui.notify(`Pi memory ${sub === "disable-current" ? "disabled" : "enabled"} for ${ctx.cwd}`, "info");
        return;
      }

      if (sub === "migrate") {
        const report = await migrate(MEMORY_DIR, store);
        const checkpoint = await memoryCheckpoint(`migrate imported ${report.imported}`);
        ctx.ui.setWidget("pi-memory", [
          `Pi memory migration complete`,
          `Scanned: ${report.scanned} legacy observations`,
          `Imported: ${report.imported}`,
          `Skipped (low value): ${report.skipped}`,
          `Legacy observations preserved at: ${report.legacyObservationsPath}`,
          report.legacyIndexPath ? `Legacy index preserved at: ${report.legacyIndexPath}` : "No legacy index found",
          checkpoint.message,
        ], { placement: "belowEditor" });
        return;
      }

      ctx.ui.notify("Usage: /memory stats|health|self-test|path|search <q>|recent [n]|staleness [days]|add <title> -- <body>|archive|active|important|unimportant <id...>|promote-to-kb <id...>|extract-decisions [n] [--apply]|summarize-session [--apply]|why [n]|why-stats [n]|tool-stats [n]|git status|init|checkpoint|push|supersede|conflict|disable-current|enable-current|migrate", "warning");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await store.ensure();
    if (ctx.hasUI) ctx.ui.setStatus("pi-memory", "mem:on");
  });

  pi.on("before_agent_start", async (event, ctx) => {
    pendingMemoryPreamble = undefined;
    if (!AUTO_INJECT) return;
    if (!(await projectEnabled(ctx.cwd))) return;
    const prompt = sanitize(event.prompt ?? "");
    if (prompt.length < 8) return;
    const query = compactQuery(prompt, INJECT_QUERY_MAX_TOKENS);
    const baseRecord = {
      ts: new Date().toISOString(),
      cwd: ctx.cwd,
      project: projectName(ctx.cwd),
      promptPreview: prompt.slice(0, 200),
      promptCharCount: prompt.length,
      minScore: INJECT_MIN_SCORE,
      limit: INJECT_LIMIT,
      globalInject: GLOBAL_AUTO_INJECT,
    };
    if (query.length < 3) {
      await logInjection(INJECTION_LOG_FILE, { ...baseRecord, results: [] }).catch(() => undefined);
      return;
    }
    const results = await search(query, {
      limit: INJECT_LIMIT,
      cwd: ctx.cwd,
      projectOnly: !GLOBAL_AUTO_INJECT,
      forInjection: true,
      minScore: INJECT_MIN_SCORE,
      snippetChars: INJECT_SNIPPET_CHARS,
    });
    await logInjection(INJECTION_LOG_FILE, {
      ...baseRecord,
      results: results.map((r) => ({
        id: r.id,
        title: r.title,
        kind: r.source,
        source: r.source,
        score: r.score ?? 0,
        snippetLength: r.snippet.length,
      })),
    }).catch(() => undefined);
    if (results.length === 0) return;
    await bumpUse(results.map((r) => r.id), "injected");
    const currentProject = projectName(ctx.cwd);
    const showProject = GLOBAL_AUTO_INJECT || results.some((r) => r.project !== currentProject);
    const memoryBlock = [
      "## Pi memory (verify)",
      ...results.map((r) => `- [${r.id}] ${r.important ? "★ " : ""}${r.title}${showProject ? ` (${r.project})` : ""} — ${r.createdAt.slice(0, 10)}: ${r.snippet}`),
    ].join("\n");
    if (INJECT_PLACEMENT === "system") return { systemPrompt: `${event.systemPrompt}\n\n${memoryBlock}` };
    pendingMemoryPreamble = memoryBlock;
  });

  pi.on("context", async (event) => {
    if (!pendingMemoryPreamble || INJECT_PLACEMENT !== "user") return;
    return { messages: applyUserPreamble(event.messages, pendingMemoryPreamble) };
  });

  pi.on("agent_end", async () => {
    pendingMemoryPreamble = undefined;
  });

  // Optional, opt-in only. Default disabled. Set PI_MEMORY_AUTO_TURN_CAPTURE=true to enable.
  if (AUTO_TURN_CAPTURE) {
    pi.on("agent_end", async (event, ctx) => {
      if (!(await projectEnabled(ctx.cwd))) return;
      const messages = (event.messages ?? []) as any[];
      const { userText, assistantText, text } = compactTurnText(messages);
      if (text.length < 200 || !hasDurableSignal(`${userText}\n${assistantText}`)) return;
      const statement = decisionStatementFromTurn(text);
      if (!statement) return;
      const now = new Date().toISOString();
      const decision: Decision = {
        id: makeId(),
        createdAt: now,
        updatedAt: now,
        cwd: ctx.cwd,
        project: projectName(ctx.cwd),
        source: "turn",
        title: sanitize(statement.split(/(?<=[.!?])\s+/)[0]?.slice(0, 90) || "Captured turn"),
        text: sanitize(statement),
        tags: inferTags(statement, statement, ["turn"]),
        important: false,
        archived: false,
        retrievalCount: 0,
        injectionCount: 0,
        sourceTurnId: makeId(),
      };
      await store.add(decision);
    });
  }

  if (process.env.PI_MEMORY_DEBUG) {
    console.error(`[pi-memory] decisions=${store.config.decisionsPath}`);
  }
}
