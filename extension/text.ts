import { tokenize } from "./scoring.ts";

// Generic text helpers shared by tools, commands, and turn capture.

export function textFromContent(content: unknown): string {
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

export function truncate(text: string, n: number): string {
  return text.length <= n ? text : `${text.slice(0, n)}…`;
}

export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

export function capOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[truncated by memory-get at ${maxChars} chars; call again with fewer IDs or larger maxChars if needed]`;
}

// Query-aware excerpt: when the body is longer than maxChars, center the window
// on the earliest matching query term so the snippet shows why it matched.
export function excerpt(text: string, query: string | undefined, maxChars: number): string {
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
