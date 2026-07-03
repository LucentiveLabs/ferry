# Releasing Ferry

Ferry publishes `@lucentive-labs/ferry` to npm via
[Changesets](https://github.com/changesets/changesets) + **npm Trusted Publishing (OIDC)** —
no long-lived npm token. The workflow is `.github/workflows/release.yml`.

## Flow

1. Land changes on `main` with a changeset (`pnpm changeset`, or a markdown file under
   `.changeset/`). On push to `main`, `changesets/action` opens a **"Version Packages"** PR
   (it does not publish).
2. Merging that PR bumps the version, updates the changelog, and consumes the changesets. The
   release workflow then runs `pnpm release` (`pnpm build && changeset publish`) and publishes
   with provenance.

## One-time setup before the first publish

The Version PR is created regardless, but the **publish** step only succeeds once all of:

1. the repository is **public** (provenance requires a public repo + package);
2. the **`@lucentive-labs`** npm org/scope exists;
3. an npm **Trusted Publisher** is configured at npmjs.com → `@lucentive-labs` →
   Publishing access → Trusted Publisher:
   - **Repository:** `LucentiveLabs/ferry`
   - **Workflow filename:** `release.yml` (npm wants the filename only, not the
     full `.github/workflows/…` path — a full path fails auth on first publish)
   - **Package:** `@lucentive-labs/ferry`

With Trusted Publishing, no `NPM_TOKEN` is needed — `id-token: write` lets the npm CLI
exchange the GitHub OIDC token for a short-lived publish credential (npm CLI ≥ 11.5.1,
Node ≥ 22.14 on the runner; the workflow upgrades npm before publishing).

## Verify

```sh
npm view @lucentive-labs/ferry                     # version is live
npm view @lucentive-labs/ferry dist.attestations   # provenance present
```

Docs & homepage: https://labs.lucentive.io/libraries/ferry
