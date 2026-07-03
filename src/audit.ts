import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/** Whether a secret was injected into the child, or refused by policy. */
export type AuditDecision = "inject" | "deny";

/**
 * One append-only audit row. Records that an access DECISION happened — never
 * the value. `command` is a non-sensitive descriptor: the executable name + arg
 * count. Arguments are deliberately NOT recorded, because they are
 * caller-controlled and may contain secrets Ferry never resolved.
 */
export interface AuditRow {
  ts: string;
  secret: string;
  command: string;
  backend: string;
  decision: AuditDecision;
}

export interface AuditOptions {
  path: string;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Append one JSONL row to the audit log, creating the directory if needed. */
export function appendAudit(row: Omit<AuditRow, "ts">, opts: AuditOptions): AuditRow {
  const now = opts.now ?? Date.now;
  const full: AuditRow = {
    ts: new Date(now()).toISOString(),
    secret: row.secret,
    command: row.command,
    backend: row.backend,
    decision: row.decision,
  };
  mkdirSync(dirname(opts.path), { recursive: true });
  appendFileSync(opts.path, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** Read audit rows (optionally only the last `tail`). Missing file → `[]`. */
export function readAudit(path: string, tail?: number): AuditRow[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const slice = tail && tail > 0 ? lines.slice(-tail) : lines;
  return slice.map((line) => JSON.parse(line) as AuditRow);
}
