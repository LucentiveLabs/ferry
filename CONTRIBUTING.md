# Contributing to Ferry

Thanks for your interest in Ferry — an agent-era secrets broker. It's a small, sharp,
security-sensitive tool, so the bar is high on clarity, tests, and keeping the surface tiny.

## Setup

Ferry is a single-package [pnpm](https://pnpm.io) project. You need Node `>=20` and pnpm `10.x`.

```sh
git clone https://github.com/LucentiveLabs/ferry.git
cd ferry
pnpm install
pnpm build      # tsdown → dist/ (library + the `ferry` bin)
pnpm test       # vitest
pnpm typecheck  # tsc --noEmit
```

## Layout

```
src/
  index.ts        public API — defineFerry, op() / file() / env() backends
  cli.ts          the `ferry` command (init / run / check / list / audit / cache)
  runner.ts       spawns the child, injects env, wires the redactor + audit
  redactor.ts     boundary-safe stdout/stderr secret redaction
  glob.ts         argv-positional allow-glob matcher
  schema.ts       config validation
  audit.ts        append-only JSONL access log
  config-loader.ts / dotenv.ts   config + .env loading
  backends/       op() · file() (AES-256-GCM) · env()
```

## The bar for changes

- **Zero runtime dependencies.** Ferry is built on Node built-ins only. A PR that adds a
  runtime `dependency` won't be merged — the small, auditable surface is the whole point for
  a tool that handles secrets.
- **A secret must never leak.** Values live only in the backend, the child env, and Ferry's
  transient memory — never stdout, logs, the audit file, or a return value. Any change near
  the runner / redactor / audit needs a test proving no value escapes.
- **Tests are required.** Every behavior change ships with a vitest test. Redaction,
  allow-glob matching, and env-ownership are proven by tests, not by assertion.
- Keep the CLI output plain and the flags few.

## Security

Please do **not** open a public issue for a vulnerability — see [`SECURITY.md`](./SECURITY.md)
for private disclosure. For anything else, open a
[discussion or issue](https://github.com/LucentiveLabs/ferry/issues).
