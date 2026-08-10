# Ferry Product Contract

Status: canonical product authority. The README remains the user and security
contract for the current CLI. Update this file whenever the product boundary,
current release truth, or adoption outcome changes.

## North Star

Ferry is the trustworthy boundary between an AI agent or automation and the
credentials its work legitimately needs. An operator declares which secret a
specific command may receive; Ferry resolves it, runs that command, redacts the
combined output, and records the decision without revealing the value to the
calling agent or creating another plaintext secret store.

The product is not a secret-themed landing page or a config parser. It is the
complete local loop through which a user can authorize, verify, execute, audit,
recover, and repeat a real headless command with a materially smaller chance of
putting credentials into an agent transcript.

## User And Meaningful Outcome

The first user is a developer or operator who lets agents run deployment,
infrastructure, or API commands but refuses to paste production credentials into
prompts, shell history, logs, or captured terminal output.

The outcome is concrete: the intended child receives only the declared secrets
whose positional command policy matches; a denied or excluded declared secret
does not leak through the ambient environment; output is redacted across chunk
and stream boundaries; and every run-time injection or denial decision can be
inspected without recording a secret value or caller-controlled arguments.

## Smallest Lovable Product

The current bounded product is the portable, zero-runtime-dependency OSS CLI:

- `ferry init` scaffolds a working configuration and ignored local state;
- `ferry check` proves every declared backend resolves by name;
- `ferry list` makes policy and backend selection legible without values;
- `ferry run` performs positional allowlist matching, owned-env isolation,
  injection, boundary-safe redaction, and append-only decision audit;
- `--only` and `--clean-env` narrow the authority and ambient environment;
- `ferry cache` supports approved headless reuse through the encrypted file
  backend; and
- `ferry audit` gives the operator a bounded run-time injection and denial
  history.

That loop must work from package install through a real allowed and denied child
command. A passing parser unit test, package page, generated config, or encrypted
file alone is not the Ferry product.

## Current Truth

As of 2026-08-10:

- `@lucentive-labs/ferry@0.1.2` is public on npm as `latest`, published through
  npm Trusted Publishing with provenance.
- The CLI and library are implemented with Node built-ins at runtime and cover
  config loading, three backends, positional policy, owned declared-env
  handling, cross-stream redaction, execution, audit, and release packaging.
- Ferry protects only secrets declared in its trusted configuration. Undeclared
  ambient secrets still reach the child unless `--clean-env` is selected.
- An explicitly allowed child may misuse a secret it receives. Ferry does not
  defend a compromised host, `/proc` inspection, or malicious trusted config.
- The encrypted-file master key still comes from `FERRY_FILE_KEY`; OS-keychain
  custody, rotation, hosted service, team sync, cloud secret backends, and GUI
  are not implemented.
- `ferry check` and `ferry cache` resolve plaintext from their configured
  backends but do not currently append audit rows. The audit covers `ferry run`
  injection and denial decisions, not every backend read or cache mutation.
- The hosted security workflow blocks leaked secrets and reports dependency and
  SAST findings under its v1 policy. A full dependency/SAST blocking scan is a
  separate release-candidate receipt until the hosted policy is strengthened.
- The public package is usable without an account, hosted control plane, sales
  workflow, or Lucentive One session.

Verdict: Ferry is a real, bounded OSS product at v0.1.2, not a hosted secret
platform. Its current CLI surface may be described as shipped; unimplemented
north-star extensions may not.

## Required End-To-End User Journey

1. The user installs the exact package and reads its threat boundary.
2. `ferry init` produces an editable trusted policy and adds `.ferry/` to the
   ignore file without printing or inventing a secret. The state directory is
   created lazily by the first audit or cache write.
3. The user assigns each declared secret a backend and the narrow command argv
   patterns that may receive it.
4. `ferry check` shows resolution success or a named, actionable failure without
   exposing a value.
5. An allowed `ferry run` gives the child exactly the selected secrets; the same
   secret is refused to a non-matching command, and both decisions are audited.
6. stdout and stderr remain useful while every injected value is redacted even
   across chunks or stream boundaries.
7. When headless reuse is appropriate, the user performs the one-time cache step
   with explicit custody, verifies the encrypted store, and repeats the command
   without a biometric prompt or plaintext persistence.
8. The user can inspect, rotate or remove the backend value, tighten policy,
   upgrade, and report a vulnerability through a private channel without losing
   the audit trail. Cache rotation re-runs `ferry cache`; removing cached state
   is currently a manual deletion of the encrypted store rather than a
   per-secret `uncache` command.

## Maintainer And Release Journey

The maintainer reproduces failures without real credentials, adds boundary and
negative tests, runs typecheck/test/build/package/security gates, records a
changeset, merges the generated version PR, publishes only through GitHub OIDC,
and verifies npm version, provenance, installability, CLI help, and an allowed
plus denied smoke from the published tarball. A green source commit is not a
release until the registry artifact and provenance are readable.

## Identity, Authorization, And Data

Ferry has no human account or hosted session. Local operating-system access,
trusted config authorship, backend authentication, and command policy are
separate authorities; none is represented as a Ferry login. The decision audit
stores secret name, backend, decision, timestamp, and executable plus argument
count—not values or raw arguments.

Lucentive One is intentionally not required for this anonymous public CLI. If a
future Lucentive-operated hosted or collaborative surface introduces
authenticated humans, it must use Lucentive One from its first production slice
while Ferry continues to own product-local secret policy and authorization. A
backend identity or encrypted store is not a replacement human login.

## Commercial And Ecosystem Boundary

The current package is MIT-licensed Lucentive Labs open source and has no paid
entitlement, managed support promise, or hosted service. Its ecosystem handoff is
discovery and documentation through the Lucentive Labs catalogue, then canonical
installation and security guidance in this repository. Do not infer a paid or
managed product from catalogue publication or npm availability.

## Product Definition Of Done

A Ferry release is a `complete-surface-only` product increment when:

- the install → init → configure → check → allowed/denied run → redacted output
  → audit journey works from the published tarball;
- every new authority path has denial, ambient-env, output-boundary, audit, and
  secret-negative coverage proportional to its risk;
- the README threat model and current limitations match the exact code;
- typecheck, tests, package lint, the hosted secret-blocking/reporting security
  policy, and an attached full dependency/SAST blocking scan pass for the exact
  release candidate;
- npm version, `latest`, provenance, and a clean install are verified after
  publication; and
- no completion claim implies the hosted, team, rotation, keychain, or cloud
  capabilities that remain unbuilt.

## Depth Before Breadth

Deepen the local broker before adding a hosted platform: reduce unsafe ambient
environment use without silent compatibility breaks, improve actionable policy
and backend diagnostics without leaking values, exercise real cross-platform
install and backend smokes, make cache custody and recovery clearer, and measure
whether users reach a repeat safe headless run. Hosted accounts, GUI, team sync,
more backends, and autonomous rotation are justified only when they solve an
observed user barrier that the complete local loop cannot.
