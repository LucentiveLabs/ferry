/**
 * A backend resolves a secret's plaintext value from a `ref`. The value is
 * returned to Ferry's transient memory only — backends must never log it.
 */
export interface Backend {
  resolve(ref: string): Promise<string>;
}
