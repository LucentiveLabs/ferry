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

Then verify the published tarball, not the source checkout. Replace `0.1.1`
with the version just published; the sentinel below is test data, not a secret.

```sh
set -eu
release_smoke_dir="$(mktemp -d)"
cd "$release_smoke_dir"
npm init -y >/dev/null
npm install --save-exact @lucentive-labs/ferry@0.1.1 >/dev/null
published_version="$(./node_modules/.bin/ferry --version)"
test "$published_version" = "0.1.1"
printf '%s\n' "$published_version"
./node_modules/.bin/ferry --help >/dev/null
./node_modules/.bin/ferry init

cat > ferry.config.mjs <<'EOF'
import { defineFerry, env } from "@lucentive-labs/ferry";
export default defineFerry({
  secrets: {
    RELEASE_SMOKE: { backend: env(), allow: ["node *"] },
  },
  audit: ".ferry/audit.log",
});
EOF

export RELEASE_SMOKE="ferry-published-smoke-sentinel"
allowed_output="$(./node_modules/.bin/ferry run --only RELEASE_SMOKE -- \
  node -e 'process.stdout.write(process.env.RELEASE_SMOKE)')"
test "$allowed_output" = "[redacted:RELEASE_SMOKE]"

if ./node_modules/.bin/ferry run --only RELEASE_SMOKE -- sh -c 'exit 0'; then
  echo "denied command unexpectedly ran" >&2
  exit 1
fi
audit_output="$(./node_modules/.bin/ferry audit --tail 2)"
printf '%s\n' "$audit_output"
case "$audit_output" in
  *inject*RELEASE_SMOKE*) ;;
  *) echo "missing inject audit row" >&2; exit 1 ;;
esac
case "$audit_output" in
  *deny*RELEASE_SMOKE*) ;;
  *) echo "missing deny audit row" >&2; exit 1 ;;
esac
if grep -R "ferry-published-smoke-sentinel" .ferry; then
  echo "sentinel leaked into Ferry state" >&2
  exit 1
fi
```

The smoke must show the exact published version, redact the allowed value,
refuse the denied command, and record `inject` plus `deny` rows without the
sentinel or raw argv. Remove the validated `release_smoke_dir` afterward.

Docs & homepage: https://labs.lucentive.io/libraries/ferry
