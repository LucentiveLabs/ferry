import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EnvBackend } from "./env";
import { FileBackend } from "./file";
import { OpBackend, type OpExec } from "./op";

describe("EnvBackend", () => {
  it("resolves from a stubbed env source", async () => {
    const backend = new EnvBackend({ MY_SECRET: "value-123" });
    await expect(backend.resolve("MY_SECRET")).resolves.toBe("value-123");
  });

  it("throws a clean error when the variable is unset", async () => {
    const backend = new EnvBackend({});
    await expect(backend.resolve("MISSING")).rejects.toThrow(/"MISSING" is not set/);
  });
});

describe("FileBackend", () => {
  let dir: string;
  let store: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ferry-file-"));
    store = join(dir, "secrets.enc.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips cache -> encrypt -> resolve -> decrypt", async () => {
    const backend = new FileBackend({ path: store, key: "test-passphrase" });
    backend.cache("CONVEX_DEPLOY_KEY", "the-real-value");
    await expect(backend.resolve("CONVEX_DEPLOY_KEY")).resolves.toBe("the-real-value");
  });

  it("does not store the plaintext on disk", async () => {
    const backend = new FileBackend({ path: store, key: "test-passphrase" });
    backend.cache("K", "PLAINTEXT-SECRET");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(store, "utf8")).not.toContain("PLAINTEXT-SECRET");
  });

  it("fails to decrypt with the wrong key", async () => {
    new FileBackend({ path: store, key: "right-key" }).cache("K", "v");
    const wrong = new FileBackend({ path: store, key: "wrong-key" });
    await expect(wrong.resolve("K")).rejects.toThrow(/failed to decrypt/);
  });

  it("errors when the key is missing", async () => {
    const backend = new FileBackend({ path: store });
    expect(() => backend.cache("K", "v")).toThrow(/FERRY_FILE_KEY is not set/);
  });

  it("errors for an unknown name", async () => {
    const backend = new FileBackend({ path: store, key: "k" });
    await expect(backend.resolve("NOPE")).rejects.toThrow(/no cached secret named "NOPE"/);
  });

  it.skipIf(process.platform === "win32")(
    "enforces 0600 even on a pre-existing loose-mode store",
    async () => {
      const { writeFileSync, statSync } = await import("node:fs");
      writeFileSync(store, "{}\n", { mode: 0o644 }); // pre-create world-readable
      new FileBackend({ path: store, key: "k" }).cache("K", "v");
      expect(statSync(store).mode & 0o777).toBe(0o600);
    },
  );
});

describe("OpBackend", () => {
  it("calls `op read <ref>` and returns the trimmed stdout", async () => {
    const exec = vi.fn<OpExec>(async () => ({ stdout: "resolved-value\n", stderr: "" }));
    const backend = new OpBackend(exec);
    await expect(backend.resolve("op://Vault/Item/field")).resolves.toBe("resolved-value");
    expect(exec).toHaveBeenCalledWith("op", ["read", "op://Vault/Item/field"]);
  });

  it("surfaces a clean error on failure, including the ref but never a value", async () => {
    const exec = vi.fn<OpExec>(async () => {
      throw new Error("could not read item");
    });
    const backend = new OpBackend(exec);
    await expect(backend.resolve("op://Vault/Missing/field")).rejects.toThrow(
      /op backend: failed to read "op:\/\/Vault\/Missing\/field": could not read item/,
    );
  });

  it("treats empty stdout as a failure", async () => {
    const exec = vi.fn<OpExec>(async () => ({ stdout: "   \n", stderr: "" }));
    const backend = new OpBackend(exec);
    await expect(backend.resolve("op://V/I/f")).rejects.toThrow(/empty value/);
  });
});
