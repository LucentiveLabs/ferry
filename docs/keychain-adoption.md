---
title: Keychain custody adoption
status: implementation foundation
ticket: LUC-7038
parent: LUC-6257
architecture_source: LucentiveLabs/lucentive@189173a67ae6285fed571d09b77cf4a5fcfc1d85
checked_at: 2026-11-06
---

# Keychain custody adoption

Ferry owns generic secret resolution. IAS owns connection authorization and the trusted operation broker. This change adds read-only generic-password resolution on macOS. It adds no daemon, cloud service or credential database.

```ts
import { keychain, defineFerry } from '@lucentive-labs/ferry';

export default defineFerry({
  cleanEnv: true,
  secrets: {
    SERVICE_TOKEN: {
      backend: keychain({
        service: 'org.example.service',
        account: 'approved-account',
        keychainPath: '/absolute/path/to/device.keychain-db',
      }),
      allow: ['approved-tool status'],
    },
  },
});
```

All three address fields are required. The backend never searches the default keychain list. It runs `/usr/bin/security find-generic-password` without a shell or inherited environment. Execution has a 15-second deadline and a 64 KiB limit per output stream. It discards all provider diagnostics, preserves credential whitespace, and rejects empty, NUL and invalid UTF-8 values. Locked items, missing items and provider failures produce the same safe error. OS access may require the person; Ferry does not unlock keychains or weaken access controls.

This resolver uses the caller's OS identity. Anyone who can read the item as that identity may still invoke the system tool. A 0700 directory and a permitted argv do not isolate same-UID agents. An allowed child can encode or send a credential. Output redaction is defense in depth.

Before real IAS use, the existing IAS security owner must qualify principal/workspace/run/task-revision grants, item/operation/origin binding, expiry/revocation, trusted executable identity, browser/CDP access, direct-file access and encoded egress containment. This release supplies none of that authority. Do not put this resolver or its plaintext result in model tools. The consumer must remain inside the protected broker.

Cloud-delegated records remain separate pending qualification: maintained AWS envelope encryption and managed KMS, workload secrets or short-lived identity, encrypted objects, rollback-resistant revisions, and concurrent connection refresh control. No cloud adapter is included here. Bitwarden is excluded from the IAS destination architecture. 1Password remains a migration source and rollback lane. No migration runs as part of this change.

The changeset requests the next minor version. It is not a release or an IAS dependency update. IAS must pin the reviewed published version and artifact digest, install it in the trusted consumer, and retain actual operating proof before reporting adoption. The current IAS consumer is not changed.

For synthetic proof on macOS, build and run `FERRY_KEYCHAIN_SMOKE=1 pnpm test:keychain`. The script imports the built package, creates a separate temporary keychain with generated canaries, checks resolution/redaction/policy denial, deletes the keychain, and checks that the user's search list is unchanged. It prints only check results. Provisioning passes synthetic values to the system command; this test lane is not a production write/import design. Native credential writes need a protected API that does not put values in argv. The smoke does not prove locked-keychain behavior, cross-user isolation or egress containment.

Ownership is recorded in the canonical session claim and dedicated task worktree. The newer shared resource-admission service was not deployed at implementation time. Local overlap checks do not prove cross-host exclusion.
