---
"@lucentive-labs/ferry": minor
---

Initial public release of Ferry — an agent-era secrets broker. Runs your command as a child process and injects declared secrets into its environment without ever exposing them to the calling agent: boundary-safe output redaction across stdout/stderr, a per-command argv-positional policy allowlist, an append-only JSONL audit (decisions, never values), and pluggable backends (1Password, AES-256-GCM encrypted file, process env). Zero runtime dependencies — nothing but Node built-ins between a secret and the child process.
