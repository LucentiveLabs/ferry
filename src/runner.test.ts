import type { SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

/**
 * A child double whose selected stream produces the secret and ends before
 * the other, empty stream. The real-process flake depends on exactly this
 * close ordering.
 */
function dataThenEmptyStreamSpawn(
  dataStream: "stdout" | "stderr",
  data = SECRET_VALUE,
): typeof import("node:child_process").spawn {
  return (() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();

    const source = child[dataStream];
    const empty = child[dataStream === "stdout" ? "stderr" : "stdout"];
    source.once("end", () => {
      empty.once("end", () => {
        queueMicrotask(() => child.emit("close", 0, null));
      });
      empty.end();
    });
    queueMicrotask(() => source.end(data));

    return child;
  }) as unknown as typeof import("node:child_process").spawn;
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
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
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
    expect(
      out.text(),
      `child result=${JSON.stringify(result)} stderr=${JSON.stringify(err.text())}`,
    ).toContain("[redacted:MY_SECRET]");
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

  it("keeps held stdout output on stdout when empty stderr closes later", async () => {
    const out = makeSink();
    const err = makeSink();

    const result = await run({
      config: config(),
      commandArgv: ["fake-child"],
      deps: {
        env: { MY_SECRET: SECRET_VALUE },
        stdout: out.w,
        stderr: err.w,
        now: () => 0,
        spawnFn: dataThenEmptyStreamSpawn("stdout"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(out.text()).toContain("[redacted:MY_SECRET]");
    expect(out.text()).not.toContain(SECRET_VALUE);
    expect(err.text()).toBe("");
  });

  it("keeps held stderr output on stderr when empty stdout closes later", async () => {
    const out = makeSink();
    const err = makeSink();

    const result = await run({
      config: config(),
      commandArgv: ["fake-child"],
      deps: {
        env: { MY_SECRET: SECRET_VALUE },
        stdout: out.w,
        stderr: err.w,
        now: () => 0,
        spawnFn: dataThenEmptyStreamSpawn("stderr"),
      },
    });

    expect(result.exitCode).toBe(0);
    expect(err.text()).toContain("[redacted:MY_SECRET]");
    expect(err.text()).not.toContain(SECRET_VALUE);
    expect(out.text()).toBe("");
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

  it.each([
    { reason: "denied", name: "USERPROFILE", source: "SOURCE_SECRET" },
    { reason: "denied", name: "ALIASED_SECRET", source: "USERPROFILE" },
    { reason: "excluded", name: "USERPROFILE", source: "SOURCE_SECRET" },
    { reason: "excluded", name: "ALIASED_SECRET", source: "USERPROFILE" },
  ])("cleanEnv strips $reason ownership of $name from the safe base", async ({ reason, name, source }) => {
    const out = makeSink();
    const err = makeSink();
    const ambient = "SYNTHETIC-AMBIENT-DO-NOT-FORWARD";
    vi.stubEnv("USERPROFILE", ambient);
    const resolveSecret = vi.fn(async () => SECRET_VALUE);
    const result = await run({
      config: {
        secrets: {
          [name]: { backend: env(source), allow: ["vercel *"] },
          MY_SECRET: { backend: env("MY_SECRET"), allow: ["*"] },
        },
        audit: auditPath,
      },
      cleanEnv: true,
      only: reason === "excluded" ? ["MY_SECRET"] : undefined,
      commandArgv: [
        process.execPath,
        "-e",
        "process.stdout.write(String(process.env.USERPROFILE)+'|'+process.env.MY_SECRET)",
      ],
      deps: { resolveSecret, stdout: out.w, stderr: err.w, now: () => 0 },
    });

    expect(result.exitCode).toBe(0);
    expect(result.injected).toEqual(["MY_SECRET"]);
    expect(result.denied).toEqual(reason === "denied" ? [name] : []);
    expect(resolveSecret.mock.calls).toEqual([["MY_SECRET", env("MY_SECRET")]]);
    expect(out.text()).toBe("undefined|[redacted:MY_SECRET]");
    expect(err.text()).toBe("");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"decision":"inject"');
    if (reason === "denied") {
      expect(audit).toContain('"decision":"deny"');
    } else {
      expect(audit).not.toContain(name);
    }
    for (const value of [ambient, SECRET_VALUE]) {
      expect(out.text() + err.text() + audit + JSON.stringify(result)).not.toContain(value);
    }
  });

  it.each([
    { name: "USERPROFILE", source: "SOURCE_SECRET" },
    { name: "ALIASED_SECRET", source: "USERPROFILE" },
  ])("cleanEnv reinjects and redacts authorized $name after stripping the safe base", async ({ name, source }) => {
    const out = makeSink();
    const err = makeSink();
    const ambient = "SYNTHETIC-AMBIENT-DO-NOT-FORWARD";
    vi.stubEnv("USERPROFILE", ambient);
    const result = await run({
      config: {
        secrets: { [name]: { backend: env(source), allow: ["*"] } },
        audit: auditPath,
      },
      cleanEnv: true,
      commandArgv: [
        process.execPath,
        "-e",
        `process.stdout.write(String(process.env.${source})+'|'+process.env.${name})`,
      ],
      deps: { env: { [source]: SECRET_VALUE }, stdout: out.w, stderr: err.w, now: () => 0 },
    });

    expect(result.exitCode).toBe(0);
    expect(result.injected).toEqual([name]);
    expect(result.denied).toEqual([]);
    expect(out.text()).toBe(`undefined|[redacted:${name}]`);
    expect(err.text()).toBe("");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"decision":"inject"');
    for (const value of [ambient, SECRET_VALUE]) {
      expect(out.text() + err.text() + audit + JSON.stringify(result)).not.toContain(value);
    }
  });

  it.each([
    { platform: "win32", cleanEnv: false, excluded: false },
    { platform: "win32", cleanEnv: true, excluded: false },
    { platform: "win32", cleanEnv: false, excluded: true },
    { platform: "win32", cleanEnv: true, excluded: true },
    { platform: "linux", cleanEnv: false, excluded: false },
    { platform: "linux", cleanEnv: true, excluded: false },
    { platform: "linux", cleanEnv: false, excluded: true },
    { platform: "linux", cleanEnv: true, excluded: true },
  ])("respects $platform env-name casing (clean=$cleanEnv, excluded=$excluded)", async ({ platform, cleanEnv, excluded }) => {
    const out = makeSink();
    const ambient = {
      USERPROFILE: "synthetic-profile",
      UserProfile: "synthetic-other-profile",
      APPDATA: "synthetic-appdata",
      LOCALAPPDATA: "synthetic-local-appdata",
      ferry_file_key: "synthetic-file-key",
      Ferry_Debug: "synthetic-debug",
    };
    // Simulate the platform and ambient environment without changing real OS
    // variables or spawning a platform-specific executable.
    vi.stubGlobal("process", { ...process, platform, env: ambient });
    let childEnv: NodeJS.ProcessEnv | undefined;
    const spawnFn = ((cmd: string, args: readonly string[], opts: SpawnOptions) => {
      childEnv = opts.env;
      return dataThenEmptyStreamSpawn("stdout", JSON.stringify(childEnv))(cmd, args, opts);
    }) as unknown as typeof import("node:child_process").spawn;
    const resolveSecret = vi.fn(async () => SECRET_VALUE);
    const result = await run({
      config: {
        secrets: {
          ALIAS: { backend: env("userprofile"), allow: ["approved *"] },
          appdata: { backend: env(), allow: ["approved *"] },
          localappdata: { backend: env("injected_source"), allow: ["*"] },
        },
        audit: auditPath,
      },
      commandArgv: ["fake-child"],
      cleanEnv,
      only: excluded ? ["localappdata"] : undefined,
      deps: { resolveSecret, spawnFn, stdout: out.w, stderr: out.w, now: () => 0 },
    });

    const expected: NodeJS.ProcessEnv = { localappdata: SECRET_VALUE };
    if (platform !== "win32") {
      Object.assign(expected, ambient);
      if (cleanEnv) {
        delete expected.UserProfile;
        delete expected.ferry_file_key;
        delete expected.Ferry_Debug;
      }
    }
    expect(childEnv).toEqual(expected);
    expect(result.exitCode).toBe(0);
    expect(result.injected).toEqual(["localappdata"]);
    expect(result.denied).toEqual(excluded ? [] : ["ALIAS", "appdata"]);
    expect(resolveSecret.mock.calls).toEqual([["localappdata", env("injected_source")]]);
    expect(out.text()).toContain("[redacted:localappdata]");
    const audit = readFileSync(auditPath, "utf8");
    expect(audit).toContain('"decision":"inject"');
    expect(out.text() + audit + JSON.stringify(result)).not.toContain(SECRET_VALUE);
    if (platform === "win32") {
      for (const value of Object.values(ambient)) expect(out.text()).not.toContain(value);
    }
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
