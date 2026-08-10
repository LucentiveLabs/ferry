# @lucentive-labs/ferry

**Agent-era secrets broker.** A secret should be usable by an agent or an
automation without ever being _visible_ to it.

Product promise, shipped boundary, and depth roadmap:
[`PRODUCT.md`](https://github.com/LucentiveLabs/ferry/blob/main/PRODUCT.md).

Ferry runs your command as a **child process** and injects declared secrets
into that child's environment. The value reaches `vercel` / `convex` / `curl`,
but it never touches Ferry's own stdout, its logs, the audit file, or the
calling agent's captured transcript. You authorize a **typed policy once** — no
per-use biometric prompt, works headless. Even if the child echoes a secret,
Ferry redacts it to `[redacted:NAME]` before it reaches the terminal.

Ferry is a **broker, not another place secrets sleep**: values come from
pluggable backends and are never persisted by Ferry in plaintext.

> **Zero runtime dependencies.** Ferry is built entirely on Node built-ins
> (`node:crypto`, `node:child_process`, `node:stream`, …). For a tool that
> handles secrets, a small, auditable attack surface is a feature — there is no
> third-party runtime code between your secret and the child process.

## Install

```sh
pnpm add @lucentive-labs/ferry
```

`@lucentive-labs/ferry` is published publicly on npm. The package is also
available from source for contributors: clone this repository, run
`pnpm install && pnpm build`, then use `node dist/cli.js …` (or
`pnpm link --global` to install the `ferry` command locally).

## Quickstart

```sh
ferry init                         # scaffold ferry.config.mjs + gitignore .ferry/
# edit ferry.config.mjs (see below)
ferry check                        # confirm every secret resolves (by NAME)
ferry run -- vercel deploy --prod  # inject only the secrets whose allow matches
```

That's the whole loop: declare once, then prefix any command with `ferry run --`.

## The config

`ferry.config.ts` (also `.mjs` / `.js`) declares which secrets exist, where each
resolves from, and which commands may receive it:

```ts
import { defineFerry, op, file, env } from "@lucentive-labs/ferry";

export default defineFerry({
  secrets: {
    VERCEL_TOKEN: {
      backend: op("op://Vault/Prod - Vercel/credential"),
      allow: ["vercel *"],
      description: "Vercel deploy token",
    },
    CONVEX_DEPLOY_KEY: {
      backend: file("prod.convex"),
      allow: ["convex deploy", "convex env *"],
    },
    MY_TOKEN: {
      backend: env(), // reads the secret's own NAME from process.env / .env
      allow: ["curl *"],
    },
  },
  audit: ".ferry/audit.log",
});
```

- **`secrets`** — the map key is the **environment variable** injected into the
  child (must be a valid env identifier).
- **`backend`** — where the value comes from, built with `op()` / `file()` /
  `env()`.
- **`allow`** — glob(s) permitted to receive this secret, matched
  **positionally against the command's argv** (per-arg, not a flattened
  string). Within a token `*` matches any run of characters; a trailing bare
  `*` soaks up any remaining args, otherwise the arity must match exactly — so
  a caller can't append an unauthorized extra argument, and a binary literally
  named `"vercel deploy"` can't spoof the token `vercel`. Ferry **refuses** to
  inject a secret for a command outside its allowlist — so an agent can't reuse
  a deploy token for `curl evil.com`.

`ferry init` scaffolds `ferry.config.mjs`, which loads with **zero
dependencies** via native ESM — so `ferry run` works out of the box. A `.ts`
config is also supported but loads through `tsx` (the one place Ferry leans on
a dev tool). Your config is **trusted code you author** (like a `Makefile` or
`vite.config`); Ferry does not sandbox it, so don't print a secret inside it.

## Backends

| Backend | Built with | Security | Use for |
| --- | --- | --- | --- |
| **1Password** | `op(ref)` | High | Team/prod secrets via the `op` CLI (`op read <ref>`). |
| **Encrypted file** | `file(name)` | Medium | Headless reuse. AES-256-GCM, scrypt-derived key from `FERRY_FILE_KEY`. |
| **Process env** | `env(varName?)` | Low | Local dev; reads `process.env` / a local `.env`. |

**Headless, without biometric timeouts.** `op`'s biometric prompt fails in a
headless agent loop. Decrypt **once** while present, into the encrypted file
store, then run headless forever after:

```sh
ferry cache VERCEL_TOKEN   # resolves VERCEL_TOKEN from op → encrypts into .ferry/secrets.enc.json
# then switch its backend to file("VERCEL_TOKEN") and later runs never prompt again
```

The value passes through Ferry's memory only; it is written to disk **encrypted**
and never printed.

## Commands

| Command | What it does |
| --- | --- |
| `ferry init` | Scaffold `ferry.config.mjs` and gitignore `.ferry/`. |
| `ferry run [--only N[,N]] [--clean-env] -- <cmd>` | Resolve + inject the matching secrets, run `<cmd>`, stream its output **redacted**, audit each access. `--only` restricts to named secrets; `--clean-env` forwards only a minimal safe base env. |
| `ferry check` | Validate the config and resolve every secret; reports `ok` / `missing` / `denied` **by NAME**, exits non-zero on any failure. |
| `ferry list` | Table of NAME → backend → allowed commands. No values. |
| `ferry audit [--tail N]` | Print the append-only access log. |
| `ferry cache <NAME>` | Decrypt `<NAME>` from its backend once into the encrypted file store for headless reuse. |

## Security model

- **The value's only homes** are (a) the backend, (b) the child process env, and
  (c) Ferry's transient memory. It is **never** in Ferry's stdout, its logs, the
  audit file, or the returned metadata. This is enforced and covered by a test.
- **Redaction.** Child stdout **and** stderr stream through a single, shared
  boundary-safe redactor that replaces every occurrence of each injected value
  with `[redacted:NAME]` — even when a value is split across two output chunks,
  or split half-to-stdout / half-to-stderr in a combined capture. (Because the
  redactor's held-back tail is shared, Ferry does not preserve strict
  stdout/stderr separation: a few boundary bytes of one stream may surface on
  the other. No bytes are lost and no value leaks — a deliberate tradeoff for
  cross-stream safety.)
- **Policy allowlist.** A secret is injected only when the argv matches one of
  its `allow` globs; otherwise it is refused and the denial is audited. For
  every **declared** secret Ferry **owns** its env in the child — it strips the
  destination NAME, the `env()` source variable, and its own broker vars
  (`FERRY_FILE_KEY`), then adds back only the authorized values. So a denied or
  `--only`-excluded declared secret can never reach the child through the
  ambient environment, and the file-store master key is never handed to a child.
- **Audit.** Every access appends one JSONL row `{ ts, secret, command, backend,
  decision }` — a decision record, never a value. `command` is the executable
  name + arg count; **arguments are not logged** (they are caller-controlled and
  may contain secrets Ferry never resolved), so nothing on the command line can
  accumulate in the audit log.
- **Zero runtime dependencies.** Nothing but Node built-ins stands between your
  secret and the child.

### What Ferry does NOT do

- **It only manages the secrets you DECLARE.** By default the child still
  inherits the rest of Ferry's environment, so an *undeclared* ambient secret
  (say `AWS_SECRET_ACCESS_KEY` that Ferry doesn't know about) is passed through
  and is **not** redacted. Pass `--clean-env` (or `cleanEnv: true`) to forward
  only a minimal safe base env plus the injected secrets.
- It does not stop a command you explicitly allowed from misusing a secret it
  legitimately received — `allow` scopes _which command_, not what that command
  then does with the value.
- It does not defend against a malicious child reading `/proc/self/environ`, nor
  against a compromised host. It shrinks the blast radius from the _agent's
  context/transcript_, which is the agent-era leak that motivated it.
- Your `ferry.config.*` is **trusted code you author** and is not sandboxed
  (same trust model as any config file); don't run `ferry` against a config
  from an untrusted repo, and don't print secrets inside your config.
- The `file` backend's key comes from `FERRY_FILE_KEY` in v0.1; a real OS-keychain
  integration is post-v0.1.

## Not in v0.1

Hosted service, secret rotation, cloud backends (AWS/GCP/Vault), team sync, GUI.
Portable OSS CLI first — no service required.

## Contributing & security

Contributions welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md). Ferry brokers
secrets, so please report vulnerabilities privately per
[`SECURITY.md`](./SECURITY.md), not as a public issue.

---

Part of the **Lucentive Labs** open-source catalog — homepage & docs at
https://labs.lucentive.io/libraries/ferry

[MIT](./LICENSE) © 2026 Lucentive Labs.
