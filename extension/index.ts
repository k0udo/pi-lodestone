import { strict as assert } from "node:assert";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Decision } from "./types.ts";
import {
  AUTO_INJECT,
  AUTO_TURN_CAPTURE,
  DIAGNOSTIC_LOGS,
  DIAGNOSTIC_PROMPT_PREVIEW,
  GLOBAL_AUTO_INJECT,
  INJECT_LIMIT,
  INJECT_MIN_SCORE,
  INJECT_PLACEMENT,
  INJECT_QUERY_MAX_TOKENS,
  INJECT_SNIPPET_CHARS,
  INJECTION_LOG_FILE,
  MEMORY_DIR,
  MEMORY_GET_MAX_OUTPUT_CHARS,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_SNIPPET_CHARS,
  STALENESS_DEFAULT_DAYS,
  TOOL_USAGE_LOG_FILE,
  UPDATE_USAGE_COUNTERS,
  VAULT_DIR,
  VAULT_KB_DIR,
  VAULT_MEMORY_DIR,
} from "./config.ts";
import { store } from "./store-instance.ts";
import { buildTokenWeights, inferTags, projectName, projectRoot, sameProjectScope, scoreDecision, tokenize } from "./scoring.ts";
import { computeInjectionStats, computeToolUsageStats, logInjection, logToolUsage, readRecentInjections, readRecentToolUsage, renderInjectionStats, renderInjections, renderToolUsageStats } from "./injection-log.ts";
import { migrate } from "./migrate.ts";
import { sanitize } from "./sanitize.ts";
import { capOutput, clampNumber, excerpt, textFromContent } from "./text.ts";
import { applyUserPreamble } from "./preamble.ts";
import { findPotentialDuplicate } from "./dedup.ts";
import { compactTurnText, decisionStatementFromTurn, hasDurableSignal } from "./turn.ts";
import { ensureMemoryGit, memoryCheckpoint, memoryStatus, runGit } from "./git.ts";
import { writeVaultNote } from "./vault.ts";
import { renderStaleness, staleMemories } from "./staleness.ts";

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

function compactQuery(text: string, maxTokens: number) {
  return [...new Set(tokenize(text).filter((token) => !INJECTION_QUERY_STOP_WORDS.has(token)))]
    .slice(0, Math.max(1, maxTokens))
    .join(" ");
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
  if (!DIAGNOSTIC_LOGS) return;
  await logToolUsage(TOOL_USAGE_LOG_FILE, {
    ts: new Date().toISOString(),
    tool,
    cwd,
    project: projectName(cwd),
    resultCount,
    ...extra,
  }).catch(() => undefined);
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
          source: "turn",
          title,
          text,
          tags: inferTags(title, text, ["session-summary"]),
          important: false,
          archived: true,
          retrievalCount: 0,
          injectionCount: 0,
        };
        await store.add(decision);
        const path = await writeVaultNote(decision, VAULT_MEMORY_DIR);
        if (path) await store.patch(decision.id, { kbPath: path });
        const checkpoint = await memoryCheckpoint(`summarize-session ${decision.id}`);
        const noteLine = path ? `Saved archived session summary [${decision.id}] → ${path}` : `Saved archived session summary [${decision.id}] (not eligible for injection; set PI_MEMORY_VAULT_DIR to also write a vault note)`;
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
      ...(DIAGNOSTIC_PROMPT_PREVIEW ? { promptPreview: prompt.slice(0, 200) } : {}),
      promptCharCount: prompt.length,
      minScore: INJECT_MIN_SCORE,
      limit: INJECT_LIMIT,
      globalInject: GLOBAL_AUTO_INJECT,
    };
    if (query.length < 3) {
      if (DIAGNOSTIC_LOGS) await logInjection(INJECTION_LOG_FILE, { ...baseRecord, results: [] }).catch(() => undefined);
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
    if (DIAGNOSTIC_LOGS) {
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
    }
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
