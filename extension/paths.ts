import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export function resolveProjectPath(cwd: string, path: string | undefined) {
  const raw = path?.trim() || cwd;
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (isAbsolute(raw)) return resolve(raw);
  return resolve(cwd, raw);
}
