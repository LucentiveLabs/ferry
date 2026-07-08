import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { Backend } from "./types";

/** Default on-disk location of the encrypted secret store. */
export const DEFAULT_FILE_STORE = ".ferry/secrets.enc.json";

/** One encrypted entry. All fields base64. Salt is per-entry (per-write). */
interface EncEntry {
  iv: string;
  tag: string;
  salt: string;
  ciphertext: string;
}
type EncStore = Record<string, EncEntry>;

export interface FileBackendOptions {
  /** Store path. Default: `.ferry/secrets.enc.json`. */
  path?: string;
  /**
   * Passphrase used to derive the AES-256 key (scrypt). Sourced from
   * `FERRY_FILE_KEY`. A real OS-keychain integration is post-v0.1.
   */
  key?: string;
}

/**
 * Encrypted-local backend (AES-256-GCM, scrypt-derived key). This is the
 * headless-friendly store that fixes the ".env juggling / op biometric
 * timeout" pain: `ferry cache <NAME>` decrypts a value from another backend
 * once and writes it here; later runs read it without any prompt.
 */
export class FileBackend implements Backend {
  private readonly path: string;
  private readonly key: string | undefined;

  constructor(options: FileBackendOptions = {}) {
    this.path = options.path ?? DEFAULT_FILE_STORE;
    this.key = options.key;
  }

  private requireKey(): string {
    if (!this.key || this.key === "") {
      throw new Error(
        "file backend: FERRY_FILE_KEY is not set (needed to derive the encryption key)",
      );
    }
    return this.key;
  }

  private readStore(): EncStore {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as EncStore;
    } catch {
      throw new Error(`file backend: store at "${this.path}" is corrupt or unreadable`);
    }
  }

  async resolve(name: string): Promise<string> {
    const store = this.readStore();
    const entry = store[name];
    if (!entry) {
      throw new Error(
        `file backend: no cached secret named "${name}" in ${this.path} (run: ferry cache ${name})`,
      );
    }
    const passphrase = this.requireKey();
    try {
      const salt = Buffer.from(entry.salt, "base64");
      const key = scryptSync(passphrase, salt, 32);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.iv, "base64"), {
        authTagLength: 16,
      });
      decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(entry.ciphertext, "base64")),
        decipher.final(),
      ]);
      return plain.toString("utf8");
    } catch {
      // Wrong key or tampered ciphertext — GCM auth fails. Never echo anything.
      throw new Error(
        `file backend: failed to decrypt "${name}" (wrong FERRY_FILE_KEY or tampered store)`,
      );
    }
  }

  /**
   * Encrypt and store `value` under `name`. Used by `ferry cache`: the caller
   * resolves the plaintext from the configured backend once, then hands it here
   * for headless reuse. The plaintext is never written anywhere else.
   */
  cache(name: string, value: string): void {
    const passphrase = this.requireKey();
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(value, "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();

    const store = this.readStore();
    store[name] = {
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      salt: salt.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    // Write atomically (temp + rename) so a crash mid-write can't truncate the
    // whole store, and ENFORCE 0600 on the final file: writeFileSync's `mode`
    // only applies on creation, so a pre-existing world-readable store would
    // otherwise keep its loose permissions. The dir is 0700.
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // `mode` on mkdirSync only applies on creation; tighten a pre-existing dir too.
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Best-effort: a dir we don't own (or a non-POSIX FS) shouldn't block a
      // write whose file perms we still enforce below.
    }
    const tmp = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
  }
}
