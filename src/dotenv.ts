import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal `.env` loader (zero-dep): `KEY=VALUE`, `#` comments, optional single
 * or double quotes. Does NOT override variables already present in `env`, so a
 * real environment always wins over the file.
 */
export function loadDotenv(cwd: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): void {
  const path = resolve(cwd, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key === "" || key in env) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
}
