/**
 * Tiny argv-aware command matcher (zero-dep).
 *
 * A pattern is a whitespace-separated list of token globs, matched
 * POSITIONALLY against the command's argv — NOT against a flattened
 * `"<cmd> <args…>"` string. Flattening let two attacks through:
 *
 *   1. extra trailing args slipped past a pattern (a trailing `*` in a joined
 *      string matched "…and anything else", so `aws s3 cp * s3://ok` also
 *      allowed a second `s3://evil` destination); and
 *   2. an executable literally named `"vercel deploy"` (one argv entry with a
 *      space) spoofed the pattern `vercel deploy *`.
 *
 * Positional matching closes both. Within a single token, `*` matches any run
 * of characters (so a single arg may contain spaces). A pattern token that is
 * exactly `*` AND is the LAST token soaks up zero or more remaining args. With
 * no trailing bare `*`, the argv must match the pattern's arity EXACTLY — so a
 * caller cannot append an extra argument the author never authorized.
 *
 * Examples (argv shown as a list):
 *   "vercel *"        → ["vercel", …anything]      (incl. bare ["vercel"])
 *   "convex deploy"   → ["convex", "deploy"]        (exactly, no extra args)
 *   "convex env *"    → ["convex", "env", …anything]
 *   "aws s3 cp * s3://mybucket/*"
 *                     → ["aws","s3","cp",<oneArg>,<one s3://mybucket/… arg>]
 *                        and NOTHING after it.
 */

const REGEX_SPECIALS = /[.+?^${}()|[\]\\]/g; // note: `*` is intentionally excluded

/** Compile ONE token glob to an anchored RegExp (`*` = any run of characters). */
export function tokenToRegExp(token: string): RegExp {
  const escaped = token.replace(REGEX_SPECIALS, "\\$&").replace(/\*/g, "[\\s\\S]*");
  return new RegExp(`^${escaped}$`);
}

/** Split a pattern into its token globs. */
function patternTokens(pattern: string): string[] {
  return pattern.trim().split(/\s+/).filter((t) => t !== "");
}

/** Does a single pattern match this argv, position by position? */
export function matchCommand(pattern: string, argv: readonly string[]): boolean {
  const tokens = patternTokens(pattern);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const isLast = i === tokens.length - 1;
    // A trailing bare `*` matches every remaining arg (including none).
    if (isLast && token === "*") return true;
    if (i >= argv.length) return false;
    if (!tokenToRegExp(token).test(argv[i]!)) return false;
  }
  // No trailing wildcard: reject any extra, unmatched args.
  return tokens.length === argv.length;
}

/** Is this argv permitted by ANY glob in the allowlist? */
export function isCommandAllowed(argv: readonly string[], allow: readonly string[]): boolean {
  return allow.some((pattern) => matchCommand(pattern, argv));
}
