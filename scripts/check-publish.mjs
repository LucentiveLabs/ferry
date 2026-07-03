// Publish-correctness gate for @lucentive-labs/ferry.
//
// Validates the REAL tarball (the bytes `changeset publish` ships), not the dev
// tree. `pnpm pack` applies `publishConfig`, so entry points resolve to
// ./dist/* — the exact package a consumer installs. Runs:
//   1. publint  — exports map / files / types are internally consistent
//   2. attw     — type declarations resolve under node10 / node16 / bundler
//
// Ferry is ESM-only (`"type": "module"`) and requires Node >=20, so attw runs
// with the `esm-only` profile — it validates ESM + bundler resolution and does
// not fail on legacy node10 (pre-`exports`-map) or CJS-consumer modes Ferry
// does not target.
//
// Assumes `dist/` is already built (the `lint:publish` script and CI both run
// `pnpm build` first).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const { name, version } = pkg;
const out = mkdtempSync(join(tmpdir(), "ferry-publish-"));

const run = (cmd, args) => execFileSync(cmd, args, { stdio: "inherit" });

// Pack the real tarball (respects `files` + `publishConfig`).
run("pnpm", ["pack", "--pack-destination", out]);
const tgz = join(
  out,
  readdirSync(out).find((f) => f.endsWith(".tgz")),
);

console.log(`\n▶ publint — ${name}@${version}`);
run("pnpm", ["exec", "publint", tgz]);

console.log(`\n▶ attw — ${name}@${version}`);
// ESM-only profile: Ferry targets modern ESM (Node >=20), so node10/CJS
// resolution modes are not checked.
run("pnpm", ["exec", "attw", tgz, "--profile", "esm-only"]);

console.log(`\n✓ publish checks passed for ${name}@${version}`);
