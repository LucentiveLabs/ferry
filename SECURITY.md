# Security Policy

Ferry brokers secrets, so we take reports seriously and disclose responsibly.

## Supported versions

Ferry is pre-1.0. Security fixes land on the latest published minor of
`@lucentive-labs/ferry`; older versions are not patched — please upgrade.

## Reporting a vulnerability

**Do not open a public issue for a security report.** Instead, either:

1. Use the [Security tab](https://github.com/LucentiveLabs/ferry/security) →
   **"Report a vulnerability"** (GitHub private advisory), or
2. email **security@lucentive.io**.

Please include a reproduction and the impact you observed. We aim to acknowledge within a few
days and will coordinate a fix and a disclosure timeline with you.

## Threat model

Ferry's job is to shrink the blast radius of a secret away from the *calling agent's
context/transcript* — the agent-era leak that motivated it. What Ferry guarantees:

- A declared secret's value reaches only (a) its backend, (b) the child process env, and
  (c) Ferry's transient memory — **never** Ferry's stdout, its logs, the audit file, or its
  return value (enforced and covered by a test).
- Child stdout and stderr stream through a boundary-safe redactor that rewrites every
  occurrence of an injected value to `[redacted:NAME]`, even across chunk/stream boundaries.
- A secret is injected only when the command's argv matches its `allow` glob; denials are
  audited. Ferry owns each declared secret's env var in the child, so a denied or excluded
  secret can't pass through the ambient environment.

What Ferry does **not** defend against, by design:

- A command you explicitly allowed then misusing a secret it legitimately received.
- **Undeclared** ambient secrets — the child inherits the rest of the environment unless you
  pass `--clean-env`.
- A malicious child reading `/proc/self/environ`, or a compromised host.
- Your `ferry.config.*` — it is trusted code you author (same trust model as `vite.config`)
  and is not sandboxed.

The full contract is in the "Security model" and "What Ferry does NOT do" sections of the
[README](./README.md).
