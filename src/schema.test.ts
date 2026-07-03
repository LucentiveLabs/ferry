import { describe, expect, it } from "vitest";

import {
  defineFerry,
  env,
  file,
  op,
  parseConfig,
  validateConfig,
  type FerryConfig,
} from "./schema";

describe("backend-ref helpers", () => {
  it("build the right discriminated shape", () => {
    expect(op("op://Vault/Item/field")).toEqual({ kind: "op", ref: "op://Vault/Item/field" });
    expect(file("prod.convex")).toEqual({ kind: "file", ref: "prod.convex" });
    expect(env("MY_VAR")).toEqual({ kind: "env", ref: "MY_VAR" });
    expect(env()).toEqual({ kind: "env", ref: "" });
  });
});

describe("validateConfig / parseConfig", () => {
  it("accepts a valid config", () => {
    const config = defineFerry({
      secrets: {
        VERCEL_TOKEN: { backend: op("op://V/Vercel/tok"), allow: ["vercel *"] },
        CONVEX_DEPLOY_KEY: { backend: file("prod.convex"), allow: ["convex deploy", "convex env *"] },
        MY_TOKEN: { backend: env(), allow: ["curl *"], description: "dev token" },
      },
      audit: ".ferry/audit.log",
    });
    expect(validateConfig(config)).toEqual([]);
    expect(parseConfig(config)).toBe(config);
  });

  it("rejects a non-object", () => {
    expect(validateConfig(null).length).toBeGreaterThan(0);
    expect(validateConfig(42).length).toBeGreaterThan(0);
    expect(() => parseConfig("nope")).toThrow(/invalid ferry config/);
  });

  it("errors when `secrets` is missing or wrong type", () => {
    expect(validateConfig({}).join()).toMatch(/secrets/);
    expect(validateConfig({ secrets: [] }).join()).toMatch(/secrets/);
  });

  it("errors on a missing backend", () => {
    const errs = validateConfig({ secrets: { A: { allow: ["x *"] } } });
    expect(errs.join()).toMatch(/missing a `backend`/);
  });

  it("errors on a missing / empty allow", () => {
    expect(validateConfig({ secrets: { A: { backend: env() } } }).join()).toMatch(/non-empty `allow`/);
    expect(validateConfig({ secrets: { A: { backend: env(), allow: [] } } }).join()).toMatch(
      /non-empty `allow`/,
    );
    expect(
      validateConfig({ secrets: { A: { backend: env(), allow: ["  "] } } }).join(),
    ).toMatch(/non-empty string glob/);
  });

  it("errors on an invalid backend kind", () => {
    const errs = validateConfig({ secrets: { A: { backend: { kind: "vault", ref: "x" }, allow: ["x *"] } } });
    expect(errs.join()).toMatch(/invalid backend kind/);
  });

  it("errors on an empty ref for a non-env backend", () => {
    expect(validateConfig({ secrets: { A: { backend: { kind: "op", ref: "" }, allow: ["x *"] } } }).join()).toMatch(
      /must not be empty/,
    );
    // env() may carry an empty ref (falls back to the NAME) — allowed.
    expect(validateConfig({ secrets: { A: { backend: env(), allow: ["x *"] } } })).toEqual([]);
  });

  it("errors on an invalid environment-variable name", () => {
    const errs = validateConfig({ secrets: { "9bad-name": { backend: env(), allow: ["x *"] } } });
    expect(errs.join()).toMatch(/not a valid environment variable identifier/);
  });

  it("errors on a non-string audit path", () => {
    const errs = validateConfig({ secrets: {}, audit: 5 } as unknown);
    expect(errs.join()).toMatch(/`audit` must be a string/);
  });

  it("keeps the FerryConfig type usable", () => {
    const c: FerryConfig = { secrets: { A: { backend: env(), allow: ["node *"] } } };
    expect(parseConfig(c).secrets.A?.allow).toEqual(["node *"]);
  });
});
