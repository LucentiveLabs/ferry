import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = join(here, "cli.ts");
const require = createRequire(import.meta.url);
const tsxHref = pathToFileURL(require.resolve("tsx")).href;

function ferry(
  args: string[],
  cwd: string,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", tsxHref, cliPath, ...args],
    {
      cwd,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("ferry CLI fail-closed argv", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ferry-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints usage and exits 1 with no command", () => {
    const result = ferry([], dir);
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/ferry — agent-era secrets broker/);
    expect(result.stdout).toMatch(/ferry init/);
  });

  it("prints help and exits 0 for --help and -h", () => {
    for (const flag of ["--help", "-h", "help"]) {
      const result = ferry([flag], dir);
      expect(result.status, flag).toBe(0);
      expect(result.stdout, flag).toMatch(/Usage:/);
    }
  });

  it("prints the package version for --version", () => {
    const pkg = JSON.parse(
      readFileSync(join(here, "..", "package.json"), "utf8"),
    ) as { version: string };
    const result = ferry(["--version"], dir);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
  });

  it("rejects an unknown command without treating it as a subcommand", () => {
    const result = ferry(["explode"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown command "explode"/);
    expect(result.stdout).toMatch(/Usage:/);
  });

  it("init refuses to overwrite an existing config", () => {
    const existing = join(dir, "ferry.config.mjs");
    writeFileSync(existing, "export default { secrets: {} };\n", "utf8");
    const result = ferry(["init"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/already exists — not overwriting/);
    expect(readFileSync(existing, "utf8")).toBe("export default { secrets: {} };\n");
  });

  it("init scaffolds ferry.config.mjs and gitignores .ferry/", () => {
    const result = ferry(["init"], dir);
    expect(result.status).toBe(0);
    expect(existsSync(join(dir, "ferry.config.mjs"))).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toMatch(/^\.ferry\/$/m);
    expect(readFileSync(join(dir, "ferry.config.mjs"), "utf8")).toMatch(
      /defineFerry/,
    );
  });

  it("run without -- fails closed on a missing command", () => {
    const result = ferry(["run"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing command/);
  });

  it("run rejects unknown flags", () => {
    const result = ferry(["run", "--explode", "--", "true"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/unknown flag "--explode"/);
  });

  it("list fails closed when no config exists", () => {
    const result = ferry(["list"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/no ferry config found/);
  });

  it("cache without NAME fails closed", () => {
    const result = ferry(["cache"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/missing NAME/);
  });

  it("cache rejects a name that is not declared", () => {
    writeFileSync(
      join(dir, "ferry.config.mjs"),
      "export default { secrets: {} };\n",
      "utf8",
    );
    const result = ferry(["cache", "NOT_A_SECRET"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/not a declared secret/);
    expect(result.stdout).not.toMatch(/NOT_A_SECRET=/);
  });

  it("audit rejects a non-numeric --tail", () => {
    writeFileSync(
      join(dir, "ferry.config.mjs"),
      "export default { secrets: {}, audit: \".ferry/audit.log\" };\n",
      "utf8",
    );
    const result = ferry(["audit", "--tail", "nope"], dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/--tail expects a number/);
  });
});
