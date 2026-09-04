import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDotenv } from "./dotenv";

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ferry-dotenv-"));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("loadDotenv", () => {
  it("is a no-op when .env is missing", () => {
    withTempDir((dir) => {
      const env = { EXISTING: "value" };

      loadDotenv(dir, env);

      expect(env).toEqual({ EXISTING: "value" });
    });
  });

  it("loads KEY=VALUE entries", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, ".env"), "API_TOKEN=secret\n", "utf8");
      const env: NodeJS.ProcessEnv = {};

      loadDotenv(dir, env);

      expect(env.API_TOKEN).toBe("secret");
    });
  });

  it("ignores comment lines", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, ".env"), "# API_TOKEN=secret\n", "utf8");
      const env: NodeJS.ProcessEnv = {};

      loadDotenv(dir, env);

      expect(env).toEqual({});
    });
  });

  it("strips single and double quotes from values", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, ".env"), 'SINGLE=\'one\'\nDOUBLE="two"\n', "utf8");
      const env: NodeJS.ProcessEnv = {};

      loadDotenv(dir, env);

      expect(env).toEqual({ SINGLE: "one", DOUBLE: "two" });
    });
  });

  it("does not override keys already present in the passed env", () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, ".env"), "API_TOKEN=from-file\n", "utf8");
      const env = { API_TOKEN: "from-env" };

      loadDotenv(dir, env);

      expect(env.API_TOKEN).toBe("from-env");
    });
  });
});
