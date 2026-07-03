#!/usr/bin/env node
/**
 * Ferry CLI — hand-rolled arg parsing, zero runtime dependencies.
 *
 * Commands: init · run · check · list · audit · cache · --help · --version.
 * No secret VALUE is ever printed by any command; only NAMES and decisions.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readAudit, type AuditRow } from "./audit";
import { FileBackend, DEFAULT_FILE_STORE, resolveBackend } from "./backends";
import { loadConfig, CONFIG_CANDIDATES } from "./config-loader";
import { loadDotenv } from "./dotenv";
import { run } from "./runner";
import { DEFAULT_AUDIT_PATH, type FerryConfig } from "./schema";

// Scaffolded as `.mjs` (not `.ts`): it loads with ZERO dependencies via native
// ESM import, so `ferry run` works out of the box in any project. Rename to
// `.ts` only if you want types + have `tsx` installed.
const INIT_TEMPLATE = `import { defineFerry, op, file, env } from "@lucentive-labs/ferry";

// Declare which secrets exist, where each is resolved from, and which commands
// may receive it. Ferry injects a secret into the child process env ONLY when
// the command matches one of its \`allow\` globs — and never prints the value.
export default defineFerry({
  secrets: {
    // 1Password (via the \`op\` CLI). Pair with \`ferry cache VERCEL_TOKEN\`
    // to decrypt once into the encrypted file store for headless reuse.
    // VERCEL_TOKEN: {
    //   backend: op("op://Vault/Prod - Vercel/credential"),
    //   allow: ["vercel *"],
    //   description: "Vercel deploy token",
    // },

    // Encrypted-local file store (AES-256-GCM; key from FERRY_FILE_KEY).
    // CONVEX_DEPLOY_KEY: {
    //   backend: file("prod.convex"),
    //   allow: ["convex deploy", "convex env *"],
    // },

    // Process env / .env (lowest security; local dev). env() with no arg reads
    // the secret's own NAME; pass a name to read a different variable.
    // MY_TOKEN: {
    //   backend: env(),
    //   allow: ["curl *"],
    // },
  },
  audit: ".ferry/audit.log",
});
`;

const USAGE = `ferry — agent-era secrets broker

Usage:
  ferry init                       Scaffold ferry.config.mjs + gitignore .ferry/
  ferry run [--only N[,N]] [--clean-env] -- CMD
                                   Resolve + inject declared secrets, run CMD
  ferry check                      Validate config + resolve every secret (by NAME)
  ferry list                       Show NAME -> backend -> allowed commands
  ferry audit [--tail N]           Print the append-only access log
  ferry cache NAME                 Decrypt NAME once into the encrypted file store
  ferry --help | -h                Show this help
  ferry --version                  Show version

The guarantee: a declared secret reaches the child process env, but never
Ferry's stdout, logs, audit file, or the calling agent's transcript. Even an
echoed value is redacted to [redacted:NAME].

Docs: https://labs.lucentive.io/libraries/ferry`;

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    return (JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function ensureGitignore(cwd: string): void {
  const gi = resolve(cwd, ".gitignore");
  const line = ".ferry/";
  const existing = existsSync(gi) ? readFileSync(gi, "utf8") : "";
  if (existing.split("\n").some((l) => l.trim() === line || l.trim() === ".ferry")) return;
  const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gi, `${existing}${prefix}${line}\n`, "utf8");
}

function cmdInit(cwd: string): number {
  // Don't overwrite ANY existing ferry config, whatever its extension.
  const existing = CONFIG_CANDIDATES.map((n) => resolve(cwd, n)).find((p) => existsSync(p));
  if (existing) {
    console.error(`ferry: ${existing} already exists — not overwriting`);
    return 1;
  }
  const target = resolve(cwd, "ferry.config.mjs");
  writeFileSync(target, INIT_TEMPLATE, "utf8");
  ensureGitignore(cwd);
  console.log(`Created ${target}`);
  console.log("Edit it, then run:  ferry run -- <your command>");
  return 0;
}

interface RunArgs {
  only?: string[];
  commandArgv: string[];
  cleanEnv?: boolean;
}

function parseRunArgs(rest: string[]): RunArgs {
  const sep = rest.indexOf("--");
  const flags = sep === -1 ? rest : rest.slice(0, sep);
  const commandArgv = sep === -1 ? [] : rest.slice(sep + 1);

  let only: string[] | undefined;
  let cleanEnv: boolean | undefined;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === "--only") {
      only = splitNames(flags[++i] ?? "");
    } else if (flag && flag.startsWith("--only=")) {
      only = splitNames(flag.slice("--only=".length));
    } else if (flag === "--clean-env") {
      cleanEnv = true;
    } else {
      throw new Error(`unknown flag "${flag}" for \`ferry run\``);
    }
  }

  if (commandArgv.length === 0) {
    throw new Error(
      "ferry run: missing command. Usage: ferry run [--only N[,N]] [--clean-env] -- <cmd> [args]",
    );
  }
  return { only, commandArgv, cleanEnv };
}

function splitNames(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

async function cmdRun(cwd: string, rest: string[]): Promise<number> {
  const { only, commandArgv, cleanEnv } = parseRunArgs(rest);
  loadDotenv(cwd);
  const { config } = await loadConfig(cwd);
  const result = await run({ config, commandArgv, only, cwd, cleanEnv });
  return result.exitCode;
}

/** Categorize a resolution failure by NAME/reason only (never a value). */
function classify(message: string): "missing" | "denied" {
  return /not set|no cached|does not exist|not found|empty/i.test(message) ? "missing" : "denied";
}

async function cmdCheck(cwd: string): Promise<number> {
  loadDotenv(cwd);
  const { path, config } = await loadConfig(cwd);
  console.log(`Config: ${path}`);
  const names = Object.keys(config.secrets);
  if (names.length === 0) {
    console.log("(no secrets declared)");
    return 0;
  }
  let failures = 0;
  for (const name of names) {
    const def = config.secrets[name]!;
    const backend = resolveBackend(def.backend);
    const ref = def.backend.kind === "env" ? def.backend.ref || name : def.backend.ref;
    try {
      await backend.resolve(ref);
      console.log(`  ok       ${name}  (${def.backend.kind})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = classify(message);
      failures++;
      console.log(`  ${status.padEnd(7)}  ${name}  (${def.backend.kind}) — ${message}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

async function cmdList(cwd: string): Promise<number> {
  const { config } = await loadConfig(cwd);
  const names = Object.keys(config.secrets);
  if (names.length === 0) {
    console.log("(no secrets declared)");
    return 0;
  }
  const nameW = Math.max(...names.map((n) => n.length), "NAME".length);
  console.log(`${"NAME".padEnd(nameW)}  BACKEND  ALLOW`);
  for (const name of names) {
    const def = config.secrets[name]!;
    console.log(`${name.padEnd(nameW)}  ${def.backend.kind.padEnd(7)}  ${def.allow.join(", ")}`);
  }
  return 0;
}

interface AuditArgs {
  tail?: number;
}

function parseAuditArgs(rest: string[]): AuditArgs {
  let tail: number | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--tail") {
      tail = Number.parseInt(rest[++i] ?? "", 10);
    } else if (flag && flag.startsWith("--tail=")) {
      tail = Number.parseInt(flag.slice("--tail=".length), 10);
    } else {
      throw new Error(`unknown flag "${flag}" for \`ferry audit\``);
    }
    if (tail !== undefined && Number.isNaN(tail)) {
      throw new Error("--tail expects a number");
    }
  }
  return { tail };
}

async function cmdAudit(cwd: string, rest: string[]): Promise<number> {
  const { tail } = parseAuditArgs(rest);
  const { config } = await loadConfig(cwd);
  const auditPath = resolve(cwd, config.audit ?? DEFAULT_AUDIT_PATH);
  const rows = readAudit(auditPath, tail);
  if (rows.length === 0) {
    console.log(`(no audit rows in ${auditPath})`);
    return 0;
  }
  for (const row of rows) printAuditRow(row);
  return 0;
}

function printAuditRow(row: AuditRow): void {
  console.log(`${row.ts}  ${row.decision.padEnd(6)}  ${row.secret}  (${row.backend})  ${row.command}`);
}

async function cmdCache(cwd: string, name: string | undefined): Promise<number> {
  if (!name) {
    console.error("ferry cache: missing NAME. Usage: ferry cache <NAME>");
    return 1;
  }
  loadDotenv(cwd);
  const { config } = await loadConfig(cwd);
  const def = config.secrets[name];
  if (!def) {
    console.error(`ferry cache: "${name}" is not a declared secret`);
    return 1;
  }
  if (def.backend.kind === "file") {
    console.log(`"${name}" is already file-backed; nothing to cache.`);
    return 0;
  }
  // Resolve the plaintext from the configured backend once, then hand it to the
  // encrypted file store. The value never touches stdout.
  const backend = resolveBackend(def.backend);
  const ref = def.backend.kind === "env" ? def.backend.ref || name : def.backend.ref;
  const value = await backend.resolve(ref);
  const store = new FileBackend({
    path: resolve(cwd, DEFAULT_FILE_STORE),
    key: process.env.FERRY_FILE_KEY,
  });
  store.cache(name, value);
  console.log(`Cached "${name}" into ${DEFAULT_FILE_STORE} (encrypted).`);
  console.log(`Switch its backend to file("${name}") for headless reuse.`);
  return 0;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;
  const cwd = process.cwd();

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }
  if (command === "--version" || command === "-v") {
    console.log(getVersion());
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit(cwd);
    case "run":
      return cmdRun(cwd, rest);
    case "check":
      return cmdCheck(cwd);
    case "list":
      return cmdList(cwd);
    case "audit":
      return cmdAudit(cwd, rest);
    case "cache":
      return cmdCache(cwd, rest[0]);
    default:
      console.error(`ferry: unknown command "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`ferry: ${message}`);
    process.exitCode = 1;
  });

// Re-export the config type so `import type { FerryConfig } from "@lucentive-labs/ferry/cli"` works.
export type { FerryConfig };
