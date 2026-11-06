import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { keychain, parseConfig, resolveBackend, run, KeychainBackend, type KeychainExec } from "../index";

const item = { service: "org.example.ferry.test", account: "test-account", keychainPath: "/tmp/ferry-test.keychain-db" };
const ref = keychain(item).ref;

describe("KeychainBackend", () => {
  it("pins executable, exact lookup, clean environment and execution bounds", async () => {
    const value = `  ${randomBytes(24).toString("hex")} \n`;
    const exec = vi.fn<KeychainExec>(async () => Buffer.from(`${value}\n`));
    const result = await new KeychainBackend(exec, "darwin").resolve(ref);
    expect(result === value).toBe(true);
    expect(exec).toHaveBeenCalledWith("/usr/bin/security", [
      "find-generic-password", "-s", item.service, "-a", item.account, "-w", item.keychainPath,
    ], { encoding: "buffer", env: {}, shell: false, timeout: 15_000, killSignal: "SIGKILL", maxBuffer: 65_536 });
  });

  it("does not execute on an unsupported host", async () => {
    const exec = vi.fn<KeychainExec>();
    await expect(new KeychainBackend(exec, "linux").resolve(ref)).rejects.toThrow("macOS is required");
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects malformed references before executing, without echoing input", async () => {
    const marker = randomBytes(24).toString("hex");
    const exec = vi.fn<KeychainExec>();
    for (const invalid of [marker, "{}", JSON.stringify({ ...item, keychainPath: "-d" }),
      JSON.stringify({ ...item, keychainPath: "/tmp/../login.keychain-db" }),
      JSON.stringify({ ...item, account: "" }), JSON.stringify({ ...item, extra: marker }),
      JSON.stringify({ ...item, service: "a\0b" }), JSON.stringify({ ...item, service: "x".repeat(8193) })]) {
      const error = await new KeychainBackend(exec, "darwin").resolve(invalid).catch((cause: unknown) => cause);
      expect(String(error)).toBe("Error: keychain backend: invalid item reference");
      expect(String(error).includes(marker)).toBe(false);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("suppresses provider errors, stdout, stderr and causes for all failure classes", async () => {
    const marker = randomBytes(24).toString("hex");
    for (const code of [44, 36, "ENOENT", "ETIMEDOUT", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"]) {
      const exec: KeychainExec = async () => {
        throw Object.assign(new Error(marker), { code, stdout: marker, stderr: marker, cause: marker });
      };
      const error = await new KeychainBackend(exec, "darwin").resolve(ref).catch((cause: unknown) => cause);
      expect(String(error)).toBe("Error: keychain backend: item unavailable or access denied");
      expect(JSON.stringify(error).includes(marker)).toBe(false);
      expect(error instanceof Error && error.cause === undefined).toBe(true);
    }
  });

  it("rejects empty, oversized, NUL and invalid UTF-8 output with the same safe error", async () => {
    for (const output of [Buffer.alloc(0), Buffer.from("\n"), Buffer.alloc(65_537, 97), Buffer.from([0, 10]), Buffer.from([255, 10])]) {
      await expect(new KeychainBackend(async () => output, "darwin").resolve(ref))
        .rejects.toThrow("item unavailable or access denied");
    }
  });

  it("is available from the public backend resolver", () => {
    expect(resolveBackend(keychain(item))).toBeInstanceOf(KeychainBackend);
    expect(parseConfig({ secrets: { TOKEN: { backend: keychain(item), allow: ["tool"] } } }).secrets.TOKEN?.backend.kind).toBe("keychain");
  });

  it("does not resolve or spawn for an explicitly denied policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ferry-keychain-denied-"));
    const exec = vi.fn<KeychainExec>();
    const spawnFn = vi.fn();
    try {
      await expect(run({
        config: { secrets: { TOKEN: { backend: keychain(item), allow: ["approved"] } }, audit: join(dir, "audit.jsonl") },
        commandArgv: ["unapproved"], only: ["TOKEN"], cleanEnv: true,
        deps: { keychainExec: exec, spawnFn: spawnFn as unknown as typeof import("node:child_process").spawn },
      })).rejects.toThrow("not allowed");
      expect(exec).not.toHaveBeenCalled();
      expect(spawnFn).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(dir, "audit.jsonl"), "utf8")).backend).toBe("keychain");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform !== "darwin")("uses the public runner with redacted output, clean env and value-free metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ferry-keychain-run-"));
    const value = randomBytes(24).toString("hex");
    let output = "";
    const sink = new Writable({ write(chunk, _encoding, callback) { output += String(chunk); callback(); } });
    try {
      const result = await run({
        config: { secrets: { TOKEN: { backend: keychain(item), allow: ["*"] } }, audit: join(dir, "audit.jsonl") },
        commandArgv: [process.execPath, "-e", "process.stdout.write(process.env.TOKEN)"], cleanEnv: true,
        deps: { keychainExec: async () => Buffer.from(`${value}\n`), stdout: sink, stderr: sink },
      });
      expect(result.exitCode).toBe(0);
      expect(output).toBe("[redacted:TOKEN]");
      expect(JSON.stringify(result).includes(value)).toBe(false);
      expect(readFileSync(join(dir, "audit.jsonl"), "utf8").includes(value)).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
