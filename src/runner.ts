import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

import { appendAudit } from "./audit";
import { resolveBackend, type BackendDeps } from "./backends";
import { isCommandAllowed } from "./glob";
import { RedactionEngine, type RedactionTarget } from "./redactor";
import { DEFAULT_AUDIT_PATH, type BackendRef, type FerryConfig, type SecretDef } from "./schema";

/** Dependencies for a run — all injectable for tests; all optional at runtime. */
export interface RunDeps extends BackendDeps {
  /** Where redacted child stdout goes. Defaults to `process.stdout`. */
  stdout?: Writable;
  /** Where redacted child stderr goes. Defaults to `process.stderr`. */
  stderr?: Writable;
  /** Injectable clock for audit rows. */
  now?: () => number;
  /** Override the child spawner (tests). */
  spawnFn?: typeof spawn;
  /**
   * Override secret resolution wholesale (tests). Given a name + its backend
   * ref, return the plaintext value. When set, backend deps are ignored.
   */
  resolveSecret?: (name: string, backend: BackendRef) => Promise<string>;
}

export interface RunOptions {
  config: FerryConfig;
  /** The command + args, e.g. `["vercel", "deploy", "--prod"]`. */
  commandArgv: string[];
  /** Restrict injection to these secret NAMES (must be declared). */
  only?: string[];
  /** Working directory for the child. */
  cwd?: string;
  /**
   * Forward only a minimal, safe base environment (PATH/HOME/…) to the child
   * instead of Ferry's full ambient env. Closes the blast radius of UNDECLARED
   * ambient secrets (AWS creds, other API keys) that Ferry does not manage and
   * therefore cannot redact. Overrides `config.cleanEnv`.
   */
  cleanEnv?: boolean;
  deps?: RunDeps;
}

/** Non-sensitive result metadata. Contains NO secret values. */
export interface RunResult {
  exitCode: number;
  /** NAMES injected into the child env. */
  injected: string[];
  /** NAMES refused by policy for this command. */
  denied: string[];
  /**
   * A non-sensitive command descriptor: the executable name + arg count (e.g.
   * `"vercel (+2 args)"`). Arguments are deliberately NOT recorded — they are
   * caller-controlled and may contain secrets.
   */
  command: string;
}

/**
 * Env vars that carry Ferry's OWN broker credentials/config. They are never
 * handed to a child, so a spawned command can't read the file-store master key
 * (and then decrypt the whole encrypted store) or Ferry's debug switches.
 */
const BROKER_ENV_VARS = ["FERRY_FILE_KEY", "FERRY_DEBUG"] as const;

/**
 * A conservative allowlist forwarded to the child in `cleanEnv` mode — enough
 * for normal tools to run (locate binaries, home dir, locale) without exposing
 * arbitrary ambient secrets.
 */
const CLEAN_ENV_PASSTHROUGH = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TMPDIR", "TEMP", "TMP", "PWD", "TZ",
  // Windows equivalents.
  "SystemRoot", "SYSTEMROOT", "PATHEXT", "COMSPEC", "WINDIR",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
] as const;

async function resolveValue(name: string, def: SecretDef, deps: RunDeps): Promise<string> {
  if (deps.resolveSecret) return deps.resolveSecret(name, def.backend);
  const backend = resolveBackend(def.backend, deps);
  return backend.resolve(envRefFor(name, def));
}

/** The env var an `env()` backend actually reads (falls back to the NAME). */
function envRefFor(name: string, def: SecretDef): string {
  return def.backend.kind === "env" ? def.backend.ref || name : def.backend.ref;
}

/** Redact secret values out of a display string (audit / result / errors). */
function redactString(input: string, targets: RedactionTarget[]): string {
  const engine = new RedactionEngine(targets);
  return engine.push(input) + engine.flush();
}

/**
 * Build the child's environment.
 *
 * In the default (passthrough) mode Ferry OWNS every secret-related var: it
 * deletes every declared secret's destination NAME, every `env()` backend
 * SOURCE ref, and its own broker vars — THEN adds back only the injected
 * (policy-allowed) values. So a secret that policy DENIED, or that `--only`
 * excluded, or that a differently-named alias would have carried, can never
 * leak to the child through the ambient environment.
 *
 * In `cleanEnv` mode only a small safe allowlist is forwarded plus the injected
 * values, shrinking the blast radius of undeclared ambient secrets too.
 */
function buildChildEnv(
  config: FerryConfig,
  injectedEnv: Record<string, string>,
  cleanEnv: boolean,
): NodeJS.ProcessEnv {
  if (cleanEnv) {
    const env: NodeJS.ProcessEnv = {};
    for (const key of CLEAN_ENV_PASSTHROUGH) {
      const v = process.env[key];
      if (v !== undefined) env[key] = v;
    }
    return Object.assign(env, injectedEnv);
  }

  const strip = new Set<string>(BROKER_ENV_VARS);
  for (const [name, def] of Object.entries(config.secrets)) {
    strip.add(name);
    if (def.backend.kind === "env") strip.add(def.backend.ref || name);
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of strip) delete env[key];
  return Object.assign(env, injectedEnv);
}

/** Resolve when a readable side has fully drained (or closed/errored). */
type StreamConsumer = { promise: Promise<void>; open: () => number };

/**
 * The core path: resolve declared secrets (optionally filtered by `--only`),
 * ENFORCE the per-command allow policy (a secret is injected only if one of its
 * globs matches the argv), spawn the child with the injected env, stream its
 * stdout/stderr through a SHARED redaction engine, write audit rows, and
 * propagate the child's exit code.
 *
 * The secret value only ever lives in (a) the backend, (b) the child env, and
 * (c) transient memory here. It is never written to `stdout`, the audit log, or
 * the returned metadata.
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const { config, commandArgv } = opts;
  const deps = opts.deps ?? {};
  const cleanEnv = opts.cleanEnv ?? config.cleanEnv ?? false;

  if (commandArgv.length === 0) {
    throw new Error("ferry run: no command provided (usage: ferry run -- <cmd> [args])");
  }
  const [cmd, ...args] = commandArgv;
  const auditPath = config.audit ?? DEFAULT_AUDIT_PATH;

  const only = opts.only && opts.only.length > 0 ? new Set(opts.only) : null;
  if (only) {
    for (const name of only) {
      if (!(name in config.secrets)) {
        throw new Error(`ferry run: --only "${name}" is not a declared secret`);
      }
    }
  }

  // Pass 1 — decide, then resolve allowed secrets. We resolve BEFORE writing any
  // audit row so the audited command string can be redacted against the values.
  const injectedEnv: Record<string, string> = {};
  const targets: RedactionTarget[] = [];
  const injected: string[] = [];
  const denied: string[] = [];
  let onlyDenied: { name: string; allow: string[] } | null = null;

  for (const [name, def] of Object.entries(config.secrets)) {
    if (only && !only.has(name)) continue;

    if (!isCommandAllowed(commandArgv, def.allow)) {
      denied.push(name);
      // An explicit --only request for a denied secret is a hard error; remember
      // it and throw AFTER auditing the decision below.
      if (only && only.has(name)) onlyDenied = { name, allow: def.allow };
      continue;
    }

    const value = await resolveValue(name, def, deps);
    injectedEnv[name] = value;
    targets.push({ name, value });
    injected.push(name);
  }

  // Ferry never persists command ARGUMENTS. They are caller-controlled and may
  // contain secrets of ANY kind — a declared secret Ferry denied, a secret from
  // a backend Ferry didn't resolve, or an unrelated credential for another tool.
  // Redacting only against the injected values would let those survive into the
  // audit log / `ferry audit` / RunResult.command. So we record ONLY the
  // executable name + arg count; argv[0] is still redacted against the injected
  // values as defense-in-depth.
  const argCount = args.length;
  const command =
    redactString(cmd ?? "", targets) +
    (argCount > 0 ? ` (+${argCount} arg${argCount === 1 ? "" : "s"})` : "");

  for (const [name, def] of Object.entries(config.secrets)) {
    if (only && !only.has(name)) continue;
    const decision = injected.includes(name) ? "inject" : "deny";
    appendAudit(
      { secret: name, command, backend: def.backend.kind, decision },
      { path: auditPath, now: deps.now },
    );
  }

  if (onlyDenied) {
    // Reference only the command NAME (argv[0]), never the redacted-but-still-
    // full command string, in the thrown error.
    throw new Error(
      `ferry run: secret "${onlyDenied.name}" is not allowed for command "${cmd}" ` +
        `(allow: ${onlyDenied.allow.join(", ")})`,
    );
  }

  const outSink = deps.stdout ?? process.stdout;
  const errSink = deps.stderr ?? process.stderr;
  const spawnFn = deps.spawnFn ?? spawn;

  const childEnv = buildChildEnv(config, injectedEnv, cleanEnv);

  const child = spawnFn(cmd as string, args, {
    env: childEnv,
    stdio: ["inherit", "pipe", "pipe"],
    cwd: opts.cwd,
  });

  // ONE shared redaction engine across both streams, so a value split across
  // stdout and stderr (which a combined capture would reassemble) is caught.
  const engine = new RedactionEngine(targets);
  let openStreams = 0;
  const consume = (readable: Readable | null | undefined, sink: Writable): StreamConsumer => {
    if (!readable) return { promise: Promise.resolve(), open: () => openStreams };
    openStreams++;
    const decoder = new StringDecoder("utf8");
    const promise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = (flushTail: boolean): void => {
        if (settled) return;
        settled = true;
        if (flushTail) {
          const out = engine.push(decoder.end());
          if (out) sink.write(out);
        }
        openStreams--;
        // The last stream to end releases the shared held-back tail.
        if (openStreams === 0) {
          const tail = engine.flush();
          if (tail) sink.write(tail);
        }
        resolve();
      };
      readable.on("data", (buf: Buffer) => {
        const out = engine.push(decoder.write(buf));
        if (out) sink.write(out);
      });
      readable.on("end", () => finish(true));
      readable.on("close", () => finish(true));
      readable.on("error", () => finish(false));
    });
    return { promise, open: () => openStreams };
  };

  const outDone = consume(child.stdout, outSink);
  const errDone = consume(child.stderr, errSink);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // Mirror shell convention for signal-terminated children: 128 + signum.
      if (code !== null) resolve(code);
      else if (signal) {
        const num = osConstants.signals[signal] ?? 0;
        resolve(128 + num);
      } else resolve(0);
    });
  });

  await Promise.all([outDone.promise, errDone.promise]);

  return { exitCode, injected, denied, command };
}
