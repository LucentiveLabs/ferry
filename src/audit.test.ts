import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { appendAudit, readAudit } from "./audit";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ferry-audit-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("appendAudit", () => {
  it("appends inject and deny rows with a deterministic timestamp", () => {
    withTempDir((dir) => {
      const path = join(dir, "audit.jsonl");

      const injected = appendAudit(
        { secret: "API_TOKEN", command: "curl (+2 args)", backend: "env", decision: "inject" },
        { path, now: () => 0 },
      );
      const denied = appendAudit(
        { secret: "DEPLOY_KEY", command: "curl (+2 args)", backend: "op", decision: "deny" },
        { path, now: () => 1_000 },
      );

      expect(injected.ts).toBe("1970-01-01T00:00:00.000Z");
      expect(denied.ts).toBe("1970-01-01T00:00:01.000Z");
      expect(readAudit(path)).toEqual([injected, denied]);
    });
  });

  it("creates the audit directory when it is missing", () => {
    withTempDir((dir) => {
      const path = join(dir, "missing", ".ferry", "audit.jsonl");
      expect(existsSync(path)).toBe(false);

      appendAudit(
        { secret: "API_TOKEN", command: "node", backend: "env", decision: "inject" },
        { path, now: () => 0 },
      );

      expect(existsSync(path)).toBe(true);
    });
  });

  it("persists secret names and a command descriptor, never values or raw args", () => {
    withTempDir((dir) => {
      const path = join(dir, "audit.jsonl");
      const secretValue = "supersecret-token-DO-NOT-LEAK";
      const rowWithUntrustedExtras = {
        secret: "API_TOKEN",
        command: "curl (+2 args)",
        backend: "env" as const,
        decision: "inject" as const,
        value: secretValue,
        rawArgs: ["--header", `Authorization: Bearer ${secretValue}`],
      };

      appendAudit(rowWithUntrustedExtras, { path, now: () => 0 });

      const jsonl = readFileSync(path, "utf8");
      expect(jsonl).toContain('"secret":"API_TOKEN"');
      expect(jsonl).toContain('"command":"curl (+2 args)"');
      expect(jsonl).not.toContain(secretValue);
      expect(jsonl).not.toContain("rawArgs");
      expect(readAudit(path)[0]?.command).toBe("curl (+2 args)");
    });
  });
});

describe("readAudit", () => {
  it("returns an empty array when the audit file is missing", () => {
    withTempDir((dir) => {
      expect(readAudit(join(dir, "missing.jsonl"))).toEqual([]);
    });
  });

  it("returns only the last requested rows", () => {
    withTempDir((dir) => {
      const path = join(dir, "audit.jsonl");
      for (const [index, secret] of ["FIRST", "SECOND", "THIRD"].entries()) {
        appendAudit(
          { secret, command: "node", backend: "env", decision: "inject" },
          { path, now: () => index * 1_000 },
        );
      }

      expect(readAudit(path, 2).map((row) => row.secret)).toEqual(["SECOND", "THIRD"]);
    });
  });

  it("skips empty and whitespace-only lines", () => {
    withTempDir((dir) => {
      const path = join(dir, "audit.jsonl");
      const first = {
        ts: "1970-01-01T00:00:00.000Z",
        secret: "FIRST",
        command: "node",
        backend: "env",
        decision: "inject",
      };
      const second = { ...first, secret: "SECOND", decision: "deny" };
      writeFileSync(path, `${JSON.stringify(first)}\n\n   \n${JSON.stringify(second)}\n`, "utf8");

      expect(readAudit(path)).toEqual([first, second]);
    });
  });
});
