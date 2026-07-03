import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { env, op, type FerryConfig } from "./schema";
import { run } from "./runner";

/** A collecting Writable sink that never touches the real terminal. */
function makeSink() {
  const chunks: Buffer[] = [];
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  return { w, text: () => Buffer.concat(chunks).toString("utf8") };
}

const SECRET_VALUE = "supersecret123-DO-NOT-LEAK";

describe("run — the agent-safety guarantee", () => {
  let dir: string;
  let auditPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ferry-run-"));
    auditPath = join(dir, "audit.log");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (): FerryConfig => ({
    secrets: {
      MY_SECRET: { backend: env("MY_SECRET"), allow: ["*"] },
    },
    audit: auditPath,
  });

  it("injects the secret into the child but redacts it from captured output", async () => {
    const out = makeSink();
    const err = makeSink();
    const result = await run({
      config: config(),
      // A child that echoes the injected secret to stdout.
      commandArgv: [process.execPath, "-e", "process.stdout.write(process.env.MY_SECRET)"],
      deps: {
        env: { MY_SECRET: SECRET_VALUE },
        stdout: out.w,
        stderr: err.w,
        now: () => 0,
      },
    });

    // The child DID receive the value (it echoed something), but the agent
    // only ever sees the placeholder — never the value.
    expect(out.text()).toContain("[redacted:MY_SECRET]");
    expect(out.text()).not.toContain(SECRET_VALUE);

    // Metadata is non-sensitive.
    expect(result.injected).toEqual(["MY_SECRET"]);
    expect(result.denied).toEqual([]);
    expect(result.exitCode).toBe(0);

    // The audit records the injection by NAME, and contains NO value.
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"secret":"MY_SECRET"');
    expect(audit).toContain('"decision":"inject"');
    expect(audit).not.toContain(SECRET_VALUE);
  });

  it("propagates the child's non-zero exit code", async () => {
    const out = makeSink();
    const result = await run({
      config: config(),
      commandArgv: [process.execPath, "-e", "process.exit(3)"],
      deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
    });
    expect(result.exitCode).toBe(3);
  });

  it("does NOT inject a secret whose allow does not match the command (deny)", async () => {
    const out = makeSink();
    const denyConfig: FerryConfig = {
      secrets: { MY_SECRET: { backend: env("MY_SECRET"), allow: ["vercel *"] } },
      audit: auditPath,
    };
    const result = await run({
      config: denyConfig,
      commandArgv: [process.execPath, "-e", "process.stdout.write(String(process.env.MY_SECRET))"],
      deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
    });

    expect(result.injected).toEqual([]);
    expect(result.denied).toEqual(["MY_SECRET"]);
    // The child saw no injected value.
    expect(out.text().trim()).toBe("undefined");
    expect(out.text()).not.toContain(SECRET_VALUE);

    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"decision":"deny"');
  });

  it("strips an ambient value for a denied secret so it never reaches the child", async () => {
    const out = makeSink();
    const denyConfig: FerryConfig = {
      secrets: { AMBIENT_SECRET: { backend: env("AMBIENT_SECRET"), allow: ["vercel *"] } },
      audit: auditPath,
    };
    // Simulate the secret being present in Ferry's own environment (the exact
    // case the smoke test surfaced): a denied secret must still be scrubbed.
    process.env.AMBIENT_SECRET = SECRET_VALUE;
    try {
      const result = await run({
        config: denyConfig,
        commandArgv: [
          process.execPath,
          "-e",
          "process.stdout.write(String(process.env.AMBIENT_SECRET))",
        ],
        deps: { stdout: out.w, stderr: out.w, now: () => 0 },
      });
      expect(result.denied).toEqual(["AMBIENT_SECRET"]);
      expect(out.text().trim()).toBe("undefined");
      expect(out.text()).not.toContain(SECRET_VALUE);
    } finally {
      delete process.env.AMBIENT_SECRET;
    }
  });

  it("errors when --only names a secret that policy denies", async () => {
    const denyConfig: FerryConfig = {
      secrets: { MY_SECRET: { backend: env("MY_SECRET"), allow: ["vercel *"] } },
      audit: auditPath,
    };
    await expect(
      run({
        config: denyConfig,
        commandArgv: [process.execPath, "-e", ""],
        only: ["MY_SECRET"],
        deps: { env: { MY_SECRET: SECRET_VALUE }, now: () => 0 },
      }),
    ).rejects.toThrow(/is not allowed for command/);
  });

  it("errors when --only names an undeclared secret", async () => {
    await expect(
      run({
        config: config(),
        commandArgv: [process.execPath, "-e", ""],
        only: ["NOPE"],
        deps: { env: { MY_SECRET: SECRET_VALUE }, now: () => 0 },
      }),
    ).rejects.toThrow(/not a declared secret/);
  });

  it("uses an injected resolveSecret override without touching real backends (op path)", async () => {
    const out = makeSink();
    const opConfig: FerryConfig = {
      secrets: { OP_SECRET: { backend: op("op://V/I/f"), allow: ["*"] } },
      audit: auditPath,
    };
    const result = await run({
      config: opConfig,
      commandArgv: [process.execPath, "-e", "process.stdout.write(process.env.OP_SECRET)"],
      deps: {
        resolveSecret: async () => SECRET_VALUE,
        stdout: out.w,
        stderr: out.w,
        now: () => 0,
      },
    });
    expect(result.injected).toEqual(["OP_SECRET"]);
    expect(out.text()).toContain("[redacted:OP_SECRET]");
    expect(out.text()).not.toContain(SECRET_VALUE);
  });

  // ---- Regressions for the confirmed leak/policy exploits ----

  it("strips a denied secret's aliased env SOURCE ref from the child env", async () => {
    const out = makeSink();
    const cfg: FerryConfig = {
      // Destination NAME differs from the ambient SOURCE var — the case a
      // NAME-only strip missed, leaking the value to a denied child.
      secrets: { CHILD_NAME: { backend: env("SOURCE_SECRET"), allow: ["vercel *"] } },
      audit: auditPath,
    };
    process.env.SOURCE_SECRET = SECRET_VALUE;
    try {
      const result = await run({
        config: cfg,
        commandArgv: [
          process.execPath,
          "-e",
          "process.stdout.write(String(process.env.SOURCE_SECRET))",
        ],
        deps: { stdout: out.w, stderr: out.w, now: () => 0 },
      });
      expect(result.denied).toEqual(["CHILD_NAME"]);
      expect(out.text().trim()).toBe("undefined");
      expect(out.text()).not.toContain(SECRET_VALUE);
    } finally {
      delete process.env.SOURCE_SECRET;
    }
  });

  it("never forwards the FERRY_FILE_KEY broker credential to the child", async () => {
    const out = makeSink();
    process.env.FERRY_FILE_KEY = "MASTER-KEY-DO-NOT-LEAK";
    try {
      const result = await run({
        config: config(),
        commandArgv: [
          process.execPath,
          "-e",
          "process.stdout.write(String(process.env.FERRY_FILE_KEY))",
        ],
        deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
      });
      expect(result.exitCode).toBe(0);
      expect(out.text().trim()).toBe("undefined");
    } finally {
      delete process.env.FERRY_FILE_KEY;
    }
  });

  it("redacts a value split across stdout AND stderr in a combined capture", async () => {
    // The exact cross-stream exploit: write half to stdout, close stdout, then
    // write the rest to stderr. A per-stream redactor reassembles it in a
    // combined transcript; ONE shared engine does not.
    const combined = makeSink(); // one sink capturing both fds, like an agent log
    const script =
      "const s=process.env.MY_SECRET;" +
      "process.stdout.write(s.slice(0,10));" +
      "process.stdout.end();" +
      "setTimeout(() => { process.stderr.write(s.slice(10)); }, 20);";
    const result = await run({
      config: config(),
      commandArgv: [process.execPath, "-e", script],
      deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: combined.w, stderr: combined.w, now: () => 0 },
    });
    expect(result.injected).toEqual(["MY_SECRET"]);
    expect(combined.text()).not.toContain(SECRET_VALUE);
  });

  it("does not persist command arguments — an injected secret on argv can't leak", async () => {
    const out = makeSink();
    const result = await run({
      config: config(),
      // A careless caller (or shell expansion) puts the value on argv. Arguments
      // are never recorded, so it can't survive into RunResult.command / audit.
      commandArgv: [process.execPath, "-e", "0", SECRET_VALUE],
      deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
    });
    expect(result.command).not.toContain(SECRET_VALUE);
    expect(result.command).toContain("+3 args"); // count, not the verbatim args
    expect(readFileSync(auditPath, "utf8")).not.toContain(SECRET_VALUE);
  });

  it("never persists argv, so even a DENIED secret's value on the command line can't leak", async () => {
    // The exact residual the re-review surfaced: a declared secret Ferry never
    // resolves (denied) whose plaintext the caller put on argv.
    const out = makeSink();
    const cfg: FerryConfig = {
      secrets: { DENIED_ARG: { backend: env("DENIED_ARG_SRC"), allow: ["never-matches *"] } },
      audit: auditPath,
    };
    process.env.DENIED_ARG_SRC = "DENIED-ARGV-SECRET-XYZ";
    try {
      const result = await run({
        config: cfg,
        commandArgv: [process.execPath, "-e", "0", "DENIED-ARGV-SECRET-XYZ"],
        deps: { stdout: out.w, stderr: out.w, now: () => 0 },
      });
      expect(result.denied).toEqual(["DENIED_ARG"]);
      expect(result.command).not.toContain("DENIED-ARGV-SECRET-XYZ");
      expect(readFileSync(auditPath, "utf8")).not.toContain("DENIED-ARGV-SECRET-XYZ");
    } finally {
      delete process.env.DENIED_ARG_SRC;
    }
  });

  it("maps a signal-terminated child to 128 + signum", async () => {
    const out = makeSink();
    const result = await run({
      config: config(),
      commandArgv: [process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"],
      deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
    });
    expect(result.exitCode).toBe(143); // 128 + 15 (SIGTERM)
  });

  it("cleanEnv forwards only a safe base env plus injected secrets", async () => {
    const out = makeSink();
    process.env.FERRY_TEST_AMBIENT = "AMBIENT-DO-NOT-FORWARD";
    try {
      const result = await run({
        config: config(),
        cleanEnv: true,
        commandArgv: [
          process.execPath,
          "-e",
          "process.stdout.write((process.env.FERRY_TEST_AMBIENT||'nope')+'|'+(process.env.MY_SECRET?'has-secret':'no-secret'))",
        ],
        deps: { env: { MY_SECRET: SECRET_VALUE }, stdout: out.w, stderr: out.w, now: () => 0 },
      });
      expect(result.exitCode).toBe(0);
      expect(out.text()).toBe("nope|has-secret");
    } finally {
      delete process.env.FERRY_TEST_AMBIENT;
    }
  });
});
