#!/usr/bin/env bash
# security-scan.sh — reusable deterministic security gate.
#
# One scanner entrypoint shared by three surfaces so local, pre-commit, CI, and
# the harness gate-receipt all enforce identical rules:
#   - pre-commit hook  -> --mode staged   (fast, staged secrets only)
#   - CI / gate-receipt -> --mode full    (secrets + deps + SAST)
#
# Scanners (all free, no account): gitleaks (secrets), osv-scanner (deps CVEs),
# semgrep (SAST). Missing scanners are reported and skipped locally; CI installs
# them so a skip cannot silently pass. Secrets ALWAYS block. Deps/SAST blocking
# is controlled by --fail-on so a repo can adopt in report-mode then harden.
#
# Usage: security-scan.sh [--mode staged|full] [--repo PATH] [--fail-on secrets|high|off]
set -uo pipefail

MODE="full"
REPO="$(pwd)"
FAIL_ON="high"   # secrets = block only on leaked secrets; high = also block on ANY deps/SAST finding (osv/semgrep are exit-based here, not severity-filtered — see note below); off = report only
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --fail-on) FAIL_ON="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
# Canonicalize REPO to an absolute path BEFORE resolving config, so a relative
# --repo can't miss the repo's own .gitleaks.toml and fall back to the baseline.
REPO="$(cd "$REPO" 2>/dev/null && pwd -P)" || { echo "cannot resolve --repo" >&2; exit 2; }
[ -n "$REPO" ] && [ -d "$REPO" ] || { echo "cannot resolve --repo" >&2; exit 2; }
cd "$REPO" || { echo "cannot cd to $REPO" >&2; exit 2; }

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# Resolve a gitleaks config as an ARRAY (no word-splitting / option-injection via
# a path with spaces): the repo's own .gitleaks.toml, else the kit baseline.
GL_CONFIG=()
if [ -f "$REPO/.gitleaks.toml" ]; then GL_CONFIG=(--config "$REPO/.gitleaks.toml")
elif [ -f "$SELF_DIR/gitleaks-baseline.toml" ]; then GL_CONFIG=(--config "$SELF_DIR/gitleaks-baseline.toml"); fi

have() { command -v "$1" >/dev/null 2>&1; }
SECRETS_FAIL=0
DEPS_FAIL=0
SAST_FAIL=0
echo "== security-scan (mode=$MODE fail-on=$FAIL_ON repo=$REPO) =="

# --- Secrets (gitleaks) — always blocking on a real hit -----------------------
if have gitleaks; then
  if [ "$MODE" = "staged" ]; then
    gitleaks git --staged ${GL_CONFIG[@]+"${GL_CONFIG[@]}"} --redact --no-banner || SECRETS_FAIL=1
  else
    # Full git history (tracked/committed content — the real leak vector). We do
    # NOT scan the raw working tree: gitleaks `dir` ignores .gitignore and would
    # flag local .env* secret caches that are never committed. Staged secrets are
    # caught by --mode staged (pre-commit); a committed .env is caught here.
    gitleaks git . ${GL_CONFIG[@]+"${GL_CONFIG[@]}"} --redact --no-banner || SECRETS_FAIL=1
  fi
  [ "$SECRETS_FAIL" = 1 ] && echo "❌ gitleaks: potential secret(s) detected" || echo "✅ gitleaks: clean"
else
  # Fail CLOSED: if we cannot scan for secrets, block rather than pass silently.
  # gitleaks is the one non-optional scanner (deps/SAST below may be skipped).
  echo "❌ gitleaks not installed — cannot scan for secrets; failing closed (install: brew install gitleaks)."
  SECRETS_FAIL=1
fi

if [ "$MODE" = "staged" ]; then
  # Pre-commit stops at secrets to stay fast.
  [ "$SECRETS_FAIL" = 1 ] && exit 1 || exit 0
fi

# --- Dependencies (osv-scanner) ----------------------------------------------
if have osv-scanner; then
  # osv-scanner exit codes (v2): 0 = clean, 1 = vulnerabilities found,
  # 128 = no package sources found (e.g. docs-only repo — a SKIP, not a fail).
  # Any other code is a scanner error; surface it and let --fail-on decide.
  # Per-run temp file (harness rule: never fixed shared /tmp paths).
  if OSV_OUT="$(mktemp "${TMPDIR:-/tmp}/osv-out.XXXXXX")"; then
    osv-scanner scan source -r . >"$OSV_OUT" 2>&1
    OSV_RC=$?
    case "$OSV_RC" in
      0)   echo "✅ osv-scanner: clean" ;;
      128) echo "✅ osv-scanner: no package sources found — dependency scan skipped" ;;
      1)   DEPS_FAIL=1; echo "⚠️  osv-scanner: vulnerable dependencies found:"; tail -n 40 "$OSV_OUT" ;;
      *)   DEPS_FAIL=1; echo "⚠️  osv-scanner: scanner error (exit $OSV_RC):"; tail -n 20 "$OSV_OUT" ;;
    esac
    rm -f "$OSV_OUT"
  else
    # Fail loud rather than silently skip deps if we cannot even make a temp file.
    DEPS_FAIL=1; echo "⚠️  osv-scanner: could not create temp output file (TMPDIR=${TMPDIR:-/tmp}) — dependency scan errored"
  fi
else
  echo "⚠️  osv-scanner not installed — dependency scan SKIPPED (CI must install it)"
fi

# --- SAST (semgrep) -----------------------------------------------------------
if have semgrep; then
  semgrep scan \
    --config p/owasp-top-ten --config p/secrets --config p/javascript \
    --config p/typescript --config p/react --config p/nextjs \
    --error --quiet --metrics off --timeout 120 \
    --exclude node_modules --exclude .next --exclude dist --exclude build \
    . || SAST_FAIL=1
  [ "$SAST_FAIL" = 1 ] && echo "⚠️  semgrep: findings (see output)" || echo "✅ semgrep: clean"
else
  echo "⚠️  semgrep not installed — SAST SKIPPED (CI must install it)"
fi

# --- Aggregate verdict --------------------------------------------------------
echo "== result: secrets=$SECRETS_FAIL deps=$DEPS_FAIL sast=$SAST_FAIL =="
# Secrets always block.
[ "$SECRETS_FAIL" = 1 ] && { echo "FAIL: leaked secret"; exit 1; }
case "$FAIL_ON" in
  off) echo "PASS (report-only for deps/SAST)"; exit 0 ;;
  secrets) echo "PASS (secrets clean; deps/SAST report-only)"; exit 0 ;;
  high|*)
    # NOTE: this blocks on ANY deps/SAST finding, not strictly High/Critical.
    # osv-scanner exit 1 = any vuln; semgrep --error = any finding. True
    # severity-gating (parse osv/semgrep JSON, block only High/Critical) is a
    # future enhancement; today "high" means "any deps/SAST finding blocks".
    if [ "$DEPS_FAIL" = 1 ] || [ "$SAST_FAIL" = 1 ]; then echo "FAIL: deps/SAST findings"; exit 1; fi
    echo "PASS"; exit 0 ;;
esac
