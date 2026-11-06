import { execFile, type ExecFileOptionsWithBufferEncoding } from "node:child_process";

import { parseKeychainRef } from "../schema";
import type { Backend } from "./types";

/** Test seam only. The executor is trusted code with access to the value. */
export type KeychainExec = (
  executable: string,
  args: string[],
  options: ExecFileOptionsWithBufferEncoding,
) => Promise<Buffer>;

const defaultExec: KeychainExec = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout) => {
      // Never propagate child stdout, stderr, argv, paths, or an Error cause.
      if (error) reject(new Error("keychain command failed"));
      else resolve(stdout);
    });
  });

/**
 * Read one generic-password item using the macOS system executable. No writes,
 * unlocks, default-keychain search, shell, or unbounded provider diagnostics.
 * This runs with the caller's OS identity: it is not same-UID containment.
 */
export class KeychainBackend implements Backend {
  constructor(
    private readonly exec: KeychainExec = defaultExec,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async resolve(ref: string): Promise<string> {
    const item = parseKeychainRef(ref);
    if (this.platform !== "darwin") throw new Error("keychain backend: macOS is required");
    try {
      const output = await this.exec("/usr/bin/security", [
        "find-generic-password", "-s", item.service, "-a", item.account, "-w", item.keychainPath,
      ], {
        encoding: "buffer",
        env: {},
        shell: false,
        timeout: 15_000,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
      });
      if (!Buffer.isBuffer(output) || output.length > 65_536) throw new Error();
      const text = output.toString("utf8");
      if (!Buffer.from(text, "utf8").equals(output)) throw new Error();
      // security appends one LF. Preserve the credential's own whitespace.
      const value = text.endsWith("\n") ? text.slice(0, -1) : text;
      if (!value || value.includes("\0")) throw new Error();
      return value;
    } catch {
      throw new Error("keychain backend: item unavailable or access denied");
    }
  }
}
