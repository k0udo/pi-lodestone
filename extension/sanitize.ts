import { MAX_TEXT_CHARS } from "./config.ts";

// Privacy guards applied on every write path: explicit <private> blocks are
// dropped and common secret patterns are masked before anything is persisted.

export function stripPrivate(text: string): string {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "[private omitted]");
}

export function maskSecrets(text: string): string {
  return text
    .replace(/\b([A-Za-z0-9_]*?(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Za-z0-9_]*?)\s*=\s*[^\s\n]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+\-/]+=*/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "sk-[redacted]");
}

export function sanitize(text: string, maxChars: number = MAX_TEXT_CHARS): string {
  return maskSecrets(stripPrivate(text)).trim().slice(0, maxChars);
}
