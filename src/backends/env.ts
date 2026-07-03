import type { Backend } from "./types";

/**
 * Process-env backend (lowest security; local dev). Reads from a provided env
 * source (defaults to `process.env`, which `ferry` may have hydrated from a
 * local `.env`). Injectable source keeps it testable without touching the real
 * environment.
 */
export class EnvBackend implements Backend {
  constructor(private readonly source: NodeJS.ProcessEnv = process.env) {}

  async resolve(ref: string): Promise<string> {
    const value = this.source[ref];
    if (value === undefined) {
      throw new Error(`env backend: variable "${ref}" is not set`);
    }
    return value;
  }
}
