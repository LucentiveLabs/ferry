import { execFile } from "node:child_process";

import type { Backend } from "./types";

/**
 * Runs a command and returns its stdout/stderr. Injectable so tests can stub
 * `op` without invoking the real 1Password CLI (and so a real value never has
 * to exist in a test).
 */
export type OpExec = (bin: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: OpExec = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, args, { encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Do NOT surface the child's raw stderr by default: a misconfigured
        // `op` wrapper could emit sensitive text there, and it would then flow
        // out through `ferry check` / `cache` OUTSIDE the redactor. Show it only
        // under FERRY_DEBUG (where the operator has opted into raw diagnostics).
        const code = (err as NodeJS.ErrnoException).code;
        const detail = process.env.FERRY_DEBUG
          ? `: ${(stderr && stderr.trim()) || err.message}`
          : ` (exit ${code ?? "?"}; set FERRY_DEBUG=1 for details)`;
        reject(new Error(`command failed${detail}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/**
 * 1Password backend: resolves a secret via `op read <ref>`. The value is read
 * from the child's stdout into transient memory and returned; it is never
 * logged. Because `op`'s biometric prompt fails headless, pair this with
 * `ferry cache <NAME>` to decrypt once into the encrypted `file` backend.
 */
export class OpBackend implements Backend {
  constructor(private readonly exec: OpExec = defaultExec) {}

  async resolve(ref: string): Promise<string> {
    try {
      const { stdout } = await this.exec("op", ["read", ref]);
      const value = stdout.trim();
      if (value === "") {
        throw new Error("returned an empty value");
      }
      return value;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Include the ref (an address, not a secret) but never a value.
      throw new Error(`op backend: failed to read "${ref}": ${message}`);
    }
  }
}
