/**
 * Ferry configuration contract.
 *
 * A `ferry.config.ts` (or `.mjs` / `.js`) declares which secrets exist, where
 * each one is resolved from (a backend ref built with `op()` / `file()` /
 * `env()`), and which commands are permitted to receive it. The config is a
 * plain, JSON-serializable object — no functions survive into the resolved
 * shape — so it can be loaded, validated, and audited without executing
 * arbitrary logic at read time.
 */

/** Which backend resolves a secret's value. */
export type BackendKind = "op" | "file" | "env";

/**
 * A backend reference. `kind` selects the resolver; `ref` is the backend's
 * lookup key (a 1Password `op://…` ref, a name in the encrypted file store, or
 * an env var name). Built via the `op()` / `file()` / `env()` helpers so a
 * config never hand-writes the discriminant.
 */
export interface BackendRef {
  kind: BackendKind;
  ref: string;
}

/** 1Password backend: resolves via the `op read <ref>` CLI. */
export function op(ref: string): BackendRef {
  return { kind: "op", ref };
}

/** Encrypted-local backend: resolves `name` from the AES-GCM file store. */
export function file(name: string): BackendRef {
  return { kind: "file", ref: name };
}

/**
 * Process-env backend (lowest security; local dev). With no argument the
 * secret's own declared NAME is used as the env var; pass `varName` to read a
 * differently-named variable.
 */
export function env(varName?: string): BackendRef {
  return { kind: "env", ref: varName ?? "" };
}

/** One declared secret. */
export interface SecretDef {
  /** Where the value comes from. */
  backend: BackendRef;
  /**
   * Glob(s) of commands permitted to receive this secret, matched POSITIONALLY
   * against the command's argv (per-arg, not a flattened string). Within a
   * token `*` matches any run of characters; a trailing bare `*` soaks up any
   * remaining args, otherwise the arity must match exactly (so an extra,
   * unauthorized arg is refused). e.g. `["vercel *"]`,
   * `["convex deploy", "convex env *"]`.
   */
  allow: string[];
  /** Optional human note (shown by `ferry list`). Never a value. */
  description?: string;
}

/** The full Ferry config. */
export interface FerryConfig {
  /** ENV_VAR name → declaration. The key is the variable injected into the child. */
  secrets: Record<string, SecretDef>;
  /** Append-only JSONL audit log path. Default: `.ferry/audit.log`. */
  audit?: string;
  /**
   * When true, the child receives only a minimal safe base environment
   * (PATH/HOME/…) plus the injected secrets — NOT Ferry's full ambient env.
   * Use it to keep undeclared ambient secrets (other API keys) out of the
   * child. Default: false (full passthrough, minus Ferry-managed vars).
   */
  cleanEnv?: boolean;
}

export const DEFAULT_AUDIT_PATH = ".ferry/audit.log";

const VALID_KINDS = new Set<BackendKind>(["op", "file", "env"]);
/** Valid POSIX-ish environment variable identifier. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Identity helper — gives a config object its type + a place for editor docs. */
export function defineFerry(config: FerryConfig): FerryConfig {
  return config;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Hand-validate an untrusted config shape (no schema library). Returns a list
 * of human-readable problems; an empty array means the shape is valid.
 */
export function validateConfig(input: unknown): string[] {
  const errs: string[] = [];

  if (!isRecord(input)) {
    return ["config must be an object with a `secrets` map"];
  }

  if (input.audit !== undefined && typeof input.audit !== "string") {
    errs.push("`audit` must be a string path when provided");
  }

  if (input.cleanEnv !== undefined && typeof input.cleanEnv !== "boolean") {
    errs.push("`cleanEnv` must be a boolean when provided");
  }

  const secrets = input.secrets;
  if (!isRecord(secrets)) {
    errs.push("`secrets` must be an object mapping ENV_VAR names to declarations");
    return errs;
  }

  for (const [name, raw] of Object.entries(secrets)) {
    if (!ENV_NAME_RE.test(name)) {
      errs.push(
        `secret name "${name}" is not a valid environment variable identifier (letters, digits, underscore; not starting with a digit)`,
      );
    }
    if (!isRecord(raw)) {
      errs.push(`secret "${name}" must be an object with { backend, allow }`);
      continue;
    }

    // backend
    const backend = raw.backend;
    if (!isRecord(backend)) {
      errs.push(`secret "${name}" is missing a \`backend\` (use op(), file(), or env())`);
    } else {
      if (typeof backend.kind !== "string" || !VALID_KINDS.has(backend.kind as BackendKind)) {
        errs.push(
          `secret "${name}" has an invalid backend kind "${String(backend.kind)}" (expected op | file | env)`,
        );
      }
      if (typeof backend.ref !== "string") {
        errs.push(`secret "${name}" backend is missing a string \`ref\``);
      } else if (backend.kind !== "env" && backend.ref.trim() === "") {
        // env() may legitimately carry an empty ref (falls back to the secret's own NAME).
        errs.push(`secret "${name}" backend \`ref\` must not be empty for the "${String(backend.kind)}" backend`);
      }
    }

    // allow
    const allow = raw.allow;
    if (!Array.isArray(allow) || allow.length === 0) {
      errs.push(`secret "${name}" must declare a non-empty \`allow\` array of command globs`);
    } else {
      allow.forEach((pattern, i) => {
        if (typeof pattern !== "string" || pattern.trim() === "") {
          errs.push(`secret "${name}" allow[${i}] must be a non-empty string glob`);
        }
      });
    }

    if (raw.description !== undefined && typeof raw.description !== "string") {
      errs.push(`secret "${name}" \`description\` must be a string when provided`);
    }
  }

  return errs;
}

/** Structural parse: returns a typed config or throws with all problems joined. */
export function parseConfig(input: unknown): FerryConfig {
  const errs = validateConfig(input);
  if (errs.length > 0) {
    throw new Error(`invalid ferry config:\n  - ${errs.join("\n  - ")}`);
  }
  return input as FerryConfig;
}
