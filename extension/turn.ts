import { TURN_ASSISTANT_MAX_CHARS, TURN_USER_MAX_CHARS } from "./config.ts";
import { sanitize } from "./sanitize.ts";
import { textFromContent, truncate } from "./text.ts";

// Turn-capture helpers. These extract a durable decision statement from the most
// recent user/assistant exchange and are shared by `/memory extract-decisions`,
// `/memory summarize-session`, and the opt-in agent_end auto-capture.

export function compactTurnText(messages: any[]): { userText: string; assistantText: string; text: string } {
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

export function hasDurableSignal(text: string): boolean {
  return /\b(decision|decided|remember|preference|prefer|always|never|do not|don't|root cause|workflow|architecture|migration|policy|target state|review gate|semi-automatic)\b/i.test(text);
}

export function decisionStatementFromTurn(text: string): string | undefined {
  const candidates = text
    .split(/\n+/)
    .map((line) => line.replace(/^(User|Assistant):\s*/i, "").trim())
    .filter((line) => line.length >= 30 && line.length <= 500)
    .filter((line) => /\b(decision|decided|prefer|preference|always|never|do not|don't|should|target state|architecture|workflow|review gate|semi-automatic|use .+ because)\b/i.test(line));
  return candidates[0]?.slice(0, 500);
}
