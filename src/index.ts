/**
 * Ferry — agent-era secrets broker.
 *
 * A secret should be usable by an agent/automation without ever being visible
 * to it. Ferry resolves declared secrets from pluggable backends, injects them
 * into a child process's environment, enforces a per-command allow policy,
 * redacts any echoed value from the child's output, and audits every access —
 * with ZERO runtime dependencies.
 */

// Config contract + backend-ref helpers.
export {
  defineFerry,
  parseConfig,
  validateConfig,
  op,
  file,
  env,
  DEFAULT_AUDIT_PATH,
} from "./schema";
export type { FerryConfig, SecretDef, BackendRef, BackendKind } from "./schema";

// Policy matcher (argv-aware).
export { matchCommand, tokenToRegExp, isCommandAllowed } from "./glob";

// Redaction (the safety guarantee).
export { Redactor, RedactionEngine, placeholderFor } from "./redactor";
export type { RedactionTarget } from "./redactor";

// Backends.
export {
  resolveBackend,
  EnvBackend,
  FileBackend,
  OpBackend,
  DEFAULT_FILE_STORE,
} from "./backends";
export type { Backend, OpExec, BackendDeps } from "./backends";

// Audit log.
export { appendAudit, readAudit } from "./audit";
export type { AuditRow, AuditDecision, AuditOptions } from "./audit";

// The runner.
export { run } from "./runner";
export type { RunOptions, RunResult, RunDeps } from "./runner";

// Config loading (Node-only).
export { loadConfig, findConfigPath, CONFIG_CANDIDATES } from "./config-loader";
export { loadDotenv } from "./dotenv";
