# Bounded braces compatibility fork

Unpublished MIT-licensed compatibility fork of `braces@3.0.3` for development
tooling. Parser pushes and recursive compile, expand and stringify walkers
have a fixed depth limit of 100. Callers cannot raise this bound. Escaped and
quoted braces retain upstream behavior. Invalid input is not logged to stdout.

This fixes the excessive-recursion path described in
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The scoped name identifies modified code, not an upstream patched release or
an advisory exception. `LICENSE` retains upstream copyright and MIT terms.
The root pnpm override sends every development `braces` consumer here; the
public package payload excludes this directory. Ordinary patterns and hostile
nested strings/ASTs are covered by `scripts/check-braces-bounded.mjs`.

Replace this fork with an upstream release after verifying an equivalent
non-overridable depth bound and consumer compatibility. Advisory and upstream
release status were checked on 2026-10-08; revalidate before removing it.
