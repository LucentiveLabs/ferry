#!/usr/bin/env bash
# synced-from: security-gate skill v1.0.0
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
# Severity gating (--fail-on high): osv-scanner blocks ONLY on HIGH/CRITICAL
# vulnerabilities (groups[].max_severity CVSS >= 7.0, falling back to
# database_specific.severity strings; unknown severity fails closed); semgrep
# blocks ONLY on CRITICAL/HIGH/ERROR-severity findings (MEDIUM/WARNING/LOW/INFO
# are printed report-only; anything else fails closed). Severity parsing needs
# python3 (stdlib only); if python3 is missing the gate falls back to blocking
# on ANY finding (fail closed).
#
# Per-vuln ignores: add an `osv-scanner.toml` NEXT TO EACH scanned lockfile with
# [[IgnoredVulns]] entries (id + reason) — osv-scanner loads config per scanned
# directory, so a repo-root toml does NOT cover nested lockfiles. Never
# blanket-ignore; one entry per triaged vuln.
#
# Usage: security-scan.sh [--mode staged|full] [--repo PATH] [--fail-on secrets|high|off]
set -uo pipefail

MODE="full"
REPO="$(pwd)"
FAIL_ON="high"   # secrets = block only on leaked secrets; high = also block on HIGH/CRITICAL deps vulns + CRITICAL/HIGH/ERROR-severity SAST findings (lower severities report-only); off = report only
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
DEPS_FAIL=0    # any deps finding (report line)
DEPS_BLOCK=0   # HIGH/CRITICAL deps finding, scanner error, or unparseable output
SAST_FAIL=0    # any SAST finding (report line)
SAST_BLOCK=0   # CRITICAL/HIGH/ERROR-severity SAST finding, scanner error, or unparseable output
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
  # Any other code is a scanner error; surface it and fail closed under high.
  # We scan with --format json and print our own human-readable summary; the
  # embedded python3 parser classifies each vuln HIGH/CRITICAL vs lower.
  # Per-run temp files (harness rule: never fixed shared /tmp paths).
  if OSV_OUT="$(mktemp "${TMPDIR:-/tmp}/osv-out.XXXXXX")" && OSV_ERR="$(mktemp "${TMPDIR:-/tmp}/osv-err.XXXXXX")"; then
    osv-scanner scan source --format json -r . >"$OSV_OUT" 2>"$OSV_ERR"
    OSV_RC=$?
    case "$OSV_RC" in
      0)   echo "✅ osv-scanner: clean" ;;
      128) echo "✅ osv-scanner: no package sources found — dependency scan skipped" ;;
      1)
        DEPS_FAIL=1
        if have python3; then
          # Severity classification: prefer groups[].max_severity (numeric CVSS
          # score, >= 7.0 = HIGH), fall back to database_specific.severity
          # strings. Unknown = fail closed. (severity[].score is a CVSS vector
          # STRING, not a number — deliberately not parsed; such vulns fail
          # closed as unknown.) This parser only runs when osv-scanner exited 1
          # (findings exist), so zero parsed findings = schema drift -> exit 3.
          python3 - "$OSV_OUT" <<'PY_OSV'
import json, sys

def as_float(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception as e:  # malformed/partial JSON -> distinct exit for fail-closed
    sys.stderr.write("osv JSON parse error: %s\n" % e)
    sys.exit(3)

high = 0
lower = 0
for res in data.get("results") or []:
    src = (res.get("source") or {}).get("path") or "?"
    for pkg in res.get("packages") or []:
        p = pkg.get("package") or {}
        pname = "%s@%s" % (p.get("name") or "?", p.get("version") or "?")
        group_sev = {}
        for g in pkg.get("groups") or []:
            for vid in g.get("ids") or []:
                group_sev[vid] = g.get("max_severity")
        for v in pkg.get("vulnerabilities") or []:
            vid = v.get("id") or "?"
            label = None  # True = HIGH/CRITICAL, False = lower
            detail = ""
            score = as_float(group_sev.get(vid))
            if score is not None:
                label = score >= 7.0
                detail = "cvss %.1f" % score
            else:
                sev = str((v.get("database_specific") or {}).get("severity") or "").strip().upper()
                if sev in ("HIGH", "CRITICAL"):
                    label, detail = True, sev.lower()
                elif sev in ("MODERATE", "MEDIUM", "LOW"):
                    label, detail = False, sev.lower()
                # NOTE: no severity[].score fallback — OSV's severity[].score is
                # a CVSS vector string ("CVSS:3.1/AV:N/..."), never a number, so
                # a numeric parse can't match; unknowns fail closed below.
            if label is None:
                label, detail = True, "unknown severity — fail closed"
            if label:
                high += 1
                mark = "BLOCK"
            else:
                lower += 1
                mark = "report-only"
            print("   [%s] %s %s (%s) in %s" % (mark, vid, pname, detail, src))
if high + lower == 0:
    # osv-scanner exited 1 (findings exist) yet we parsed none: the JSON shape
    # drifted (e.g. no/renamed "results" key). Fail closed as a parse failure.
    sys.stderr.write("osv reported findings but none parsed from JSON (schema drift?) — failing closed\n")
    sys.exit(3)
print("   osv summary: %d HIGH/CRITICAL (blocking), %d lower-severity (report-only)" % (high, lower))
sys.exit(1 if high else 0)
PY_OSV
          case $? in
            0) echo "⚠️  osv-scanner: lower-severity vulnerabilities only (report-only under --fail-on $FAIL_ON)" ;;
            1) DEPS_BLOCK=1; echo "❌ osv-scanner: HIGH/CRITICAL vulnerabilities found" ;;
            *) DEPS_BLOCK=1; echo "❌ osv-scanner: could not parse scanner JSON — failing closed"; tail -n 20 "$OSV_ERR" ;;
          esac
        else
          # No python3: cannot severity-gate; fail closed on ANY finding.
          DEPS_BLOCK=1
          echo "⚠️  osv-scanner: vulnerabilities found (python3 missing — blocking on ANY finding):"
          tail -n 40 "$OSV_OUT"
        fi
        ;;
      *)   DEPS_FAIL=1; DEPS_BLOCK=1; echo "⚠️  osv-scanner: scanner error (exit $OSV_RC):"; tail -n 20 "$OSV_ERR" "$OSV_OUT" 2>/dev/null ;;
    esac
    rm -f "$OSV_OUT" "$OSV_ERR"
  else
    # Fail loud rather than silently skip deps if we cannot even make a temp file.
    DEPS_FAIL=1; DEPS_BLOCK=1; echo "⚠️  osv-scanner: could not create temp output file (TMPDIR=${TMPDIR:-/tmp}) — dependency scan errored"
  fi
else
  echo "⚠️  osv-scanner not installed — dependency scan SKIPPED (CI must install it)"
fi

# --- SAST (semgrep) -----------------------------------------------------------
if have semgrep; then
  # Single --json pass; the embedded python3 parser prints a per-finding summary
  # and classifies severity: CRITICAL/HIGH/ERROR block under --fail-on high,
  # MEDIUM/WARNING/LOW/INFO are report-only, unknown severities fail closed.
  # semgrep exit codes with --error: 0 = clean, 1 = findings (any severity),
  # >1 = scanner error.
  if SG_OUT="$(mktemp "${TMPDIR:-/tmp}/semgrep-out.XXXXXX")"; then
    semgrep scan \
      --config p/owasp-top-ten --config p/secrets --config p/javascript \
      --config p/typescript --config p/react --config p/nextjs \
      --error --quiet --metrics off --timeout 120 \
      --exclude node_modules --exclude .next --exclude dist --exclude build \
      --json --output "$SG_OUT" .
    SG_RC=$?
    case "$SG_RC" in
      0) echo "✅ semgrep: clean" ;;
      1)
        SAST_FAIL=1
        if have python3; then
          # This parser only runs when semgrep (with --error) exited 1, i.e.
          # findings exist — so zero parsed findings = schema drift -> exit 3.
          python3 - "$SG_OUT" <<'PY_SG'
import json, sys

try:
    with open(sys.argv[1]) as f:
        data = json.load(f)
except Exception as e:  # malformed/partial JSON -> distinct exit for fail-closed
    sys.stderr.write("semgrep JSON parse error: %s\n" % e)
    sys.exit(3)

# Severity map: legacy (ERROR/WARNING/INFO) + newer semgrep severities
# (CRITICAL/HIGH/MEDIUM/LOW). Anything outside these buckets fails closed.
BLOCKING = ("CRITICAL", "HIGH", "ERROR")
REPORT_ONLY = ("MEDIUM", "WARNING", "LOW", "INFO")
counts = {s: 0 for s in BLOCKING + REPORT_ONLY}
unknown = 0
for r in data.get("results") or []:
    extra = r.get("extra") or {}
    sev = str(extra.get("severity") or "").strip().upper()
    if sev in counts:
        counts[sev] += 1
        mark = "BLOCK" if sev in BLOCKING else "report-only"
    else:  # future/unknown severity — fail closed
        unknown += 1
        sev = sev or "UNKNOWN"
        mark = "BLOCK"
    loc = "%s:%s" % (r.get("path") or "?", (r.get("start") or {}).get("line") or "?")
    print("   [%s] %s %s %s" % (mark, sev, r.get("check_id") or "?", loc))
if sum(counts.values()) + unknown == 0:
    # semgrep exited 1 (findings exist) yet we parsed none: the JSON shape
    # drifted (e.g. no/renamed "results" key). Fail closed as a parse failure.
    sys.stderr.write("semgrep reported findings but none parsed from JSON (schema drift?) — failing closed\n")
    sys.exit(3)
blocking = sum(counts[s] for s in BLOCKING)
print("   semgrep summary: %d CRITICAL + %d HIGH + %d ERROR (blocking), %d MEDIUM + %d WARNING (report-only), %d LOW + %d INFO (report-only), %d unknown-severity (fail closed)"
      % (counts["CRITICAL"], counts["HIGH"], counts["ERROR"],
         counts["MEDIUM"], counts["WARNING"], counts["LOW"], counts["INFO"], unknown))
if unknown:
    # Severity string outside the known map: treat like schema drift — fail
    # closed with the distinct parse-failure exit so the gate never guesses.
    sys.stderr.write("semgrep finding(s) with unrecognized severity — failing closed\n")
    sys.exit(3)
sys.exit(1 if blocking else 0)
PY_SG
          case $? in
            0) echo "⚠️  semgrep: MEDIUM/WARNING/LOW/INFO findings only (report-only under --fail-on $FAIL_ON)" ;;
            1) SAST_BLOCK=1; echo "❌ semgrep: CRITICAL/HIGH/ERROR-severity findings" ;;
            *) SAST_BLOCK=1; echo "❌ semgrep: could not parse scanner JSON or unrecognized severity — failing closed" ;;
          esac
        else
          # No python3: cannot severity-gate; fail closed on ANY finding.
          SAST_BLOCK=1
          echo "⚠️  semgrep: findings (python3 missing — blocking on ANY finding); raw JSON tail:"
          tail -n 20 "$SG_OUT"
        fi
        ;;
      *) SAST_FAIL=1; SAST_BLOCK=1; echo "⚠️  semgrep: scanner error (exit $SG_RC):"; tail -n 20 "$SG_OUT" 2>/dev/null ;;
    esac
    rm -f "$SG_OUT"
  else
    # Fail loud rather than silently skip SAST if we cannot even make a temp file.
    SAST_FAIL=1; SAST_BLOCK=1; echo "⚠️  semgrep: could not create temp output file (TMPDIR=${TMPDIR:-/tmp}) — SAST errored"
  fi
else
  echo "⚠️  semgrep not installed — SAST SKIPPED (CI must install it)"
fi

# --- Aggregate verdict --------------------------------------------------------
echo "== result: secrets=$SECRETS_FAIL deps=$DEPS_FAIL deps-blocking=$DEPS_BLOCK sast=$SAST_FAIL sast-blocking=$SAST_BLOCK =="
# Secrets always block.
[ "$SECRETS_FAIL" = 1 ] && { echo "FAIL: leaked secret"; exit 1; }
case "$FAIL_ON" in
  off) echo "PASS (report-only for deps/SAST)"; exit 0 ;;
  secrets) echo "PASS (secrets clean; deps/SAST report-only)"; exit 0 ;;
  high|*)
    # Severity-aware: deps block only on HIGH/CRITICAL (CVSS >= 7.0) osv vulns;
    # SAST blocks only on CRITICAL/HIGH/ERROR-severity semgrep findings. Scanner
    # errors, unparseable JSON, and unknown severities also block (fail loud/
    # closed, never silently pass). Lower-severity findings are reported above only.
    if [ "$DEPS_BLOCK" = 1 ] || [ "$SAST_BLOCK" = 1 ]; then echo "FAIL: HIGH/CRITICAL deps vulns or CRITICAL/HIGH/ERROR-severity SAST findings"; exit 1; fi
    if [ "$DEPS_FAIL" = 1 ] || [ "$SAST_FAIL" = 1 ]; then echo "PASS (lower-severity deps/SAST findings are report-only)"; exit 0; fi
    echo "PASS"; exit 0 ;;
esac
