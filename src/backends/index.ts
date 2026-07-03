import type { BackendRef } from "../schema";
import { EnvBackend } from "./env";
import { FileBackend } from "./file";
import { OpBackend, type OpExec } from "./op";
import type { Backend } from "./types";

/** Injectable dependencies for backend construction (tests + config). */
export interface BackendDeps {
  /** Env source for the `env` backend. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Command runner for the `op` backend. Defaults to a real `execFile`. */
  opExec?: OpExec;
  /** Store path for the `file` backend. Defaults to `.ferry/secrets.enc.json`. */
  fileStorePath?: string;
  /** Passphrase for the `file` backend. Defaults to `FERRY_FILE_KEY`. */
  fileKey?: string;
}

/** Construct the concrete backend for a ref, wiring injectable deps. */
export function resolveBackend(ref: BackendRef, deps: BackendDeps = {}): Backend {
  switch (ref.kind) {
    case "env":
      return new EnvBackend(deps.env ?? process.env);
    case "file":
      return new FileBackend({
        path: deps.fileStorePath,
        key: deps.fileKey ?? process.env.FERRY_FILE_KEY,
      });
    case "op":
      return new OpBackend(deps.opExec);
    default: {
      // Exhaustiveness guard: an unknown kind should have failed validation.
      const never: never = ref.kind;
      throw new Error(`unknown backend kind: ${String(never)}`);
    }
  }
}

export type { Backend } from "./types";
export type { OpExec } from "./op";
export { EnvBackend } from "./env";
export { FileBackend, DEFAULT_FILE_STORE } from "./file";
export { OpBackend } from "./op";
