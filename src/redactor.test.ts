import { describe, expect, it } from "vitest";

import { Redactor, type RedactionTarget } from "./redactor";

/** Push chunks through a Redactor and collect the emitted output as a string. */
function pipeThrough(targets: RedactionTarget[], chunks: (string | Buffer)[]): Promise<string> {
  const redactor = new Redactor(targets);
  const out: Buffer[] = [];
  return new Promise((resolve, reject) => {
    redactor.on("data", (d: Buffer | string) => out.push(Buffer.from(d)));
    redactor.on("end", () => resolve(Buffer.concat(out).toString("utf8")));
    redactor.on("error", reject);
    for (const chunk of chunks) redactor.write(chunk);
    redactor.end();
  });
}

const SECRET = "supersecret-token-1234567890";

describe("Redactor", () => {
  it("redacts a value delivered in a single chunk", async () => {
    const out = await pipeThrough([{ name: "TOKEN", value: SECRET }], [`before ${SECRET} after`]);
    expect(out).toBe("before [redacted:TOKEN] after");
    expect(out).not.toContain(SECRET);
  });

  it("redacts a value split across two write() calls (boundary-safe)", async () => {
    const mid = Math.floor(SECRET.length / 2);
    const out = await pipeThrough(
      [{ name: "TOKEN", value: SECRET }],
      [`start ${SECRET.slice(0, mid)}`, `${SECRET.slice(mid)} end`],
    );
    expect(out).toBe("start [redacted:TOKEN] end");
    expect(out).not.toContain(SECRET);
  });

  it("redacts a value split across three writes, one char at a time in the middle", async () => {
    const out = await pipeThrough(
      [{ name: "K", value: "ABCDEF" }],
      ["xx AB", "C", "DEF yy"],
    );
    expect(out).toBe("xx [redacted:K] yy");
    expect(out).not.toContain("ABCDEF");
  });

  it("passes unrelated text through unchanged", async () => {
    const out = await pipeThrough([{ name: "TOKEN", value: SECRET }], ["nothing to see here\n"]);
    expect(out).toBe("nothing to see here\n");
  });

  it("treats an empty secret value as a no-op (no explosion)", async () => {
    const out = await pipeThrough([{ name: "EMPTY", value: "" }], ["hello world"]);
    expect(out).toBe("hello world");
  });

  it("redacts the longest match first when one value contains another", async () => {
    const out = await pipeThrough(
      [
        { name: "SHORT", value: "abc" },
        { name: "LONG", value: "abcdef" },
      ],
      ["[abcdef]"],
    );
    // The longest (LONG) wins on the full token; SHORT does not carve it up.
    expect(out).toBe("[[redacted:LONG]]");
  });

  it("handles multiple distinct secrets", async () => {
    const out = await pipeThrough(
      [
        { name: "A", value: "alpha" },
        { name: "B", value: "bravo" },
      ],
      ["alpha then bravo"],
    );
    expect(out).toBe("[redacted:A] then [redacted:B]");
  });

  it("passes multi-byte UTF-8 through intact across a byte-split boundary", async () => {
    const emoji = Buffer.from("héllo 🚀 wörld", "utf8");
    const a = emoji.subarray(0, 8); // split mid multi-byte sequence
    const b = emoji.subarray(8);
    const out = await pipeThrough([{ name: "T", value: "zzz" }], [a, b]);
    expect(out).toBe("héllo 🚀 wörld");
  });

  // Regression: a value that is a substring of its own `[redacted:NAME]`
  // placeholder must not be re-introduced by the placeholder itself.
  it("never re-introduces a value that collides with its placeholder", async () => {
    for (const value of ["redacted", "TOKEN", "[redacted:TOKEN]"]) {
      const out = await pipeThrough([{ name: "TOKEN", value }], [`x ${value} y`]);
      expect(out).not.toContain(value);
      expect(out.startsWith("x ")).toBe(true);
      expect(out.endsWith(" y")).toBe(true);
    }
  });

  it("does not expose another target through a later name-bearing placeholder", async () => {
    const targets = [{ name: "A", value: "FOO" }, { name: "FOO", value: "x" }];
    for (const order of [targets, [...targets].reverse()]) {
      for (let split = 0; split <= 5; split += 1) {
        const input = "FOO x";
        const out = await pipeThrough(order, [input.slice(0, split), input.slice(split)]);
        for (const target of targets) expect(out).not.toContain(target.value);
      }
    }
  });

  it("does not assemble a fresh secret at placeholder boundaries", async () => {
    const targets = [{ name: "A", value: "]z" }, { name: "B", value: "long-secret" }];
    const input = "long-secretz";
    for (let split = 0; split <= input.length; split += 1) {
      const out = await pipeThrough(targets, [input.slice(0, split), input.slice(split)]);
      for (const target of targets) expect(out).not.toContain(target.value);
    }
  });

  it("finds a safe mask when every usual mask character is also a secret", async () => {
    const targets = ["redacted", "•", "*", "#", "×", "▪", "·", "‡", "�"].map((value, index) => ({ name: `K${index}`, value }));
    const input = targets.map((target) => target.value).join(" ");
    const out = await pipeThrough(targets, Array.from(input));
    for (const target of targets) expect(out).not.toContain(target.value);
    expect(out.length).toBeGreaterThan(0);
  });
});
