# @lucentive-labs/ferry

## 0.1.2

### Patch Changes

- 39c232a: Publish the canonical product boundary, correct the public release truth, and
  add a fail-closed post-publication smoke for the packaged CLI.

## 0.1.1

### Patch Changes

- eba053f: Keep redacted output on the stream that supplied the final data, independent of stdout/stderr close order, and pin the release toolchain to patched js-yaml lines.

## 0.1.0

### Minor Changes

- 5a317dd: Initial public release of Ferry — an agent-era secrets broker. Runs your command as a child process and injects declared secrets into its environment without ever exposing them to the calling agent: boundary-safe output redaction across stdout/stderr, a per-command argv-positional policy allowlist, an append-only JSONL audit (decisions, never values), and pluggable backends (1Password, AES-256-GCM encrypted file, process env). Zero runtime dependencies — nothing but Node built-ins between a secret and the child process.
