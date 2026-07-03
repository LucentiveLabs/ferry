# Changesets

This directory is managed by [Changesets](https://github.com/changesets/changesets).
Each changeset is a markdown file describing the version bump for one logical
change, plus a human-readable summary for the changelog.

- Add one with `pnpm changeset` (or author a markdown file by hand).
- Versions and changelogs are applied by `pnpm changeset version`.
- Publishing is wired in `.github/workflows/release.yml` via npm Trusted
  Publishing (OIDC) and only succeeds once the repository is public and an npm
  Trusted Publisher is configured for `@lucentive-labs/ferry` (see `RELEASING.md`).
