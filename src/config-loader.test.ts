import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findConfigPath, loadConfig } from "./config-loader";

async function withTempDir(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "ferry-config-"));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("findConfigPath", () => {
  it("prefers ferry.config.mjs over later candidates", async () => {
    await withTempDir((dir) => {
      writeFileSync(join(dir, "ferry.config.js"), "export default {};\n", "utf8");
      writeFileSync(join(dir, "ferry.config.mjs"), "export default {};\n", "utf8");

      expect(findConfigPath(dir)).toBe(join(dir, "ferry.config.mjs"));
    });
  });
});

describe("loadConfig", () => {
  it("throws when the cwd contains no Ferry config", async () => {
    await withTempDir(async (dir) => {
      expect(findConfigPath(dir)).toBeNull();
      await expect(loadConfig(dir)).rejects.toThrow(/no ferry config found/);
    });
  });

  it("loads and validates a defineFerry-style ESM default export", async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "ferry.config.mjs");
      writeFileSync(
        path,
        `const defineFerry = (config) => config;

export default defineFerry({
  secrets: {
    API_TOKEN: {
      backend: { kind: "env", ref: "SOURCE_API_TOKEN" },
      allow: ["node *"],
      description: "test fixture",
    },
  },
  audit: ".ferry/test-audit.jsonl",
  cleanEnv: true,
});
`,
        "utf8",
      );

      await expect(loadConfig(dir)).resolves.toEqual({
        path,
        config: {
          secrets: {
            API_TOKEN: {
              backend: { kind: "env", ref: "SOURCE_API_TOKEN" },
              allow: ["node *"],
              description: "test fixture",
            },
          },
          audit: ".ferry/test-audit.jsonl",
          cleanEnv: true,
        },
      });
    });
  });
});
