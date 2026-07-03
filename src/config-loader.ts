import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { parseConfig, type FerryConfig } from "./schema";

/**
 * Config loading (Node-only).
 *
 * SECURITY NOTE: a `ferry.config.*` is TRUSTED code you author, the same way a
 * Makefile, a `vite.config`, or a shell profile is. `.mjs`/`.js` configs run
 * in-process via dynamic `import()`; a `.ts` config runs in a `tsx` child.
 * Ferry only guarantees policy + redaction for the SECRETS it brokers at run
 * time; it does not sandbox your config. So don't `console.log` a secret inside
 * it, and don't run `ferry` against a config from an untrusted repo. This is
 * the same trust model as every other config-file tool, not a Ferry-specific
 * hole.
 */

/** Supported config filenames, in resolution priority order. */
export const CONFIG_CANDIDATES = ["ferry.config.ts", "ferry.config.mjs", "ferry.config.js"] as const;

/** First existing config file in `cwd`, or `null`. */
export function findConfigPath(cwd: string): string | null {
  for (const name of CONFIG_CANDIDATES) {
    const candidate = resolve(cwd, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Load + validate the config. `.mjs` / `.js` load with zero dependencies via
 * dynamic import. `.ts` is loaded by spawning the same Node with the `tsx`
 * loader (`node --import tsx`), which requires `tsx` to be installed (the only
 * situation where Ferry leans on a dev tool). The resolved config is
 * JSON-serializable, so the `.ts` loader round-trips it as JSON through a
 * sentinel-delimited child stdout.
 */
export async function loadConfig(
  cwd: string = process.cwd(),
): Promise<{ path: string; config: FerryConfig }> {
  const path = findConfigPath(cwd);
  if (!path) {
    throw new Error(
      `no ferry config found (looked for ${CONFIG_CANDIDATES.join(", ")} in ${cwd}). Run \`ferry init\`.`,
    );
  }
  const raw = path.endsWith(".ts") ? loadTsConfig(path, cwd) : await loadEsmConfig(path);
  return { path, config: parseConfig(raw) };
}

async function loadEsmConfig(path: string): Promise<unknown> {
  const mod = (await import(pathToFileURL(path).href)) as {
    default?: unknown;
    config?: unknown;
  };
  return mod.default ?? mod.config ?? mod;
}

// A high-entropy, PRINTABLE sentinel. It brackets the JSON the tsx child prints
// on stdout so incidental console output from the config is ignored. It is
// printable on purpose: embedding raw NUL bytes (an earlier approach) makes Git
// treat this security-sensitive source file as binary and hides it from diffs.
// The random suffix makes an accidental collision with real config JSON
// astronomically unlikely.
const SENTINEL = "__FERRY_CONFIG_b7c1e29d4f__";

function loadTsConfig(path: string, cwd: string): unknown {
  const url = pathToFileURL(path).href;
  // Import the config in a tsx-enabled child and print it as sentinel-wrapped
  // JSON, so any incidental console output from the config is ignored.
  const loader =
    `import(${JSON.stringify(url)})` +
    `.then((m) => { const c = m.default ?? m.config ?? m; ` +
    `process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(c) + ${JSON.stringify(SENTINEL)}); })` +
    `.catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(3); });`;

  let out: string;
  try {
    out = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", loader],
      // Capture (do NOT inherit) the loader's stderr: a config that prints a
      // secret to stderr must not stream straight to the terminal outside the
      // redactor. It is surfaced only under FERRY_DEBUG on failure.
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
  } catch (err) {
    const detail = process.env.FERRY_DEBUG
      ? ` Cause: ${err instanceof Error ? err.message : String(err)}`
      : " (set FERRY_DEBUG=1 for details)";
    throw new Error(
      `failed to load TypeScript config "${path}". Ensure \`tsx\` is installed ` +
        `(pnpm add -D tsx) or use ferry.config.mjs / ferry.config.js instead.${detail}`,
    );
  }

  const start = out.indexOf(SENTINEL);
  const end = out.lastIndexOf(SENTINEL);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`could not parse TypeScript config output from "${path}"`);
  }
  return JSON.parse(out.slice(start + SENTINEL.length, end));
}
