import { homedir } from "node:os";
import { join } from "node:path";

// Centralized runtime configuration. Every knob is an environment variable with a
// conservative default so the local-LLM hot path stays predictable. Modules import
// from here instead of re-reading process.env, keeping defaults in one place.

export const MEMORY_DIR = process.env.PI_MEMORY_DIR ?? join(homedir(), ".pi", "agent", "memory");
export const INJECTION_LOG_FILE = join(MEMORY_DIR, "injections.jsonl");
export const TOOL_USAGE_LOG_FILE = join(MEMORY_DIR, "tool-usage.jsonl");
export const OBSERVATIONS_LOG_FILE = join(MEMORY_DIR, "observations.jsonl");

export const MAX_TEXT_CHARS = Number(process.env.PI_MEMORY_MAX_TEXT_CHARS ?? 4_000);
export const AUTO_INJECT = (process.env.PI_MEMORY_AUTO_INJECT ?? "true") !== "false";
export const AUTO_TURN_CAPTURE = (process.env.PI_MEMORY_AUTO_TURN_CAPTURE ?? "false") === "true";
export const GLOBAL_AUTO_INJECT = (process.env.PI_MEMORY_GLOBAL_AUTO_INJECT ?? "false") === "true";
export const INJECT_LIMIT = Number(process.env.PI_MEMORY_INJECT_LIMIT ?? 3);
export const INJECT_MIN_SCORE = Number(process.env.PI_MEMORY_INJECT_MIN_SCORE ?? 8);
export const INJECT_SNIPPET_CHARS = Number(process.env.PI_MEMORY_INJECT_SNIPPET_CHARS ?? 180);
export const INJECT_QUERY_MAX_TOKENS = Number(process.env.PI_MEMORY_INJECT_QUERY_MAX_TOKENS ?? 32);
export const INJECT_PLACEMENT = (process.env.PI_MEMORY_INJECT_PLACEMENT ?? "user").toLowerCase() === "system" ? "system" : "user";
export const SEARCH_DEFAULT_LIMIT = Number(process.env.PI_MEMORY_SEARCH_DEFAULT_LIMIT ?? 5);
export const SEARCH_SNIPPET_CHARS = Number(process.env.PI_MEMORY_SEARCH_SNIPPET_CHARS ?? 220);
export const STALENESS_DEFAULT_DAYS = Number(process.env.PI_MEMORY_STALENESS_DAYS ?? 30);
export const MEMORY_GET_MAX_OUTPUT_CHARS = Number(process.env.PI_MEMORY_GET_MAX_OUTPUT_CHARS ?? 10_000);
export const UPDATE_USAGE_COUNTERS = (process.env.PI_MEMORY_UPDATE_USAGE_COUNTERS ?? "false") === "true";
export const DIAGNOSTIC_LOGS = (process.env.PI_MEMORY_DIAGNOSTIC_LOGS ?? "false") === "true";
export const DIAGNOSTIC_PROMPT_PREVIEW = (process.env.PI_MEMORY_DIAGNOSTIC_PROMPT_PREVIEW ?? "false") === "true";
export const TURN_USER_MAX_CHARS = Number(process.env.PI_MEMORY_TURN_USER_MAX_CHARS ?? 1_200);
export const TURN_ASSISTANT_MAX_CHARS = Number(process.env.PI_MEMORY_TURN_ASSISTANT_MAX_CHARS ?? 1_800);

// Optional bridge to a Markdown vault directory. Opt-in: set PI_MEMORY_VAULT_DIR
// to a vault root to enable `promote-to-kb`. Empty by default so the package
// never writes outside the memory store unless asked.
export const VAULT_DIR = process.env.PI_MEMORY_VAULT_DIR ?? "";
export const VAULT_MEMORY_DIR = process.env.PI_MEMORY_VAULT_MEMORY_DIR ?? "Agent/Memory";
export const VAULT_KB_DIR = process.env.PI_MEMORY_VAULT_KB_DIR ?? "Agent/KB";
