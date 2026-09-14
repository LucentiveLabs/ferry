import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";

/** A value to scrub from a stream, and the NAME its placeholder reveals. */
export interface RedactionTarget {
  name: string;
  value: string;
}

/**
 * Choose a placeholder that cannot reproduce any protected value, including
 * across the boundary between a placeholder and adjacent output.
 *
 * Normally `[redacted:NAME]`. But if the value is a substring of that text
 * (pathologically: the value IS `"redacted"`, the NAME, or literally
 * `"[redacted:NAME]"`), emitting the placeholder would re-introduce the value —
 * violating the byte-level "the value never appears" guarantee. In that case
 * emit an opaque mask built from a character the value does NOT contain, so the
 * mask can never reproduce it.
 */
export function placeholderFor(name: string, value: string): string {
  return placeholderForValues(name, value, [value]);
}

function placeholderForValues(
  name: string,
  value: string,
  protectedValues: readonly string[],
): string {
  const values = protectedValues.filter((candidate) => candidate.length > 0);
  const base = `[redacted:${name}]`;
  // The delimiters also have to be absent from every value: otherwise a
  // placeholder and its neighbour could assemble a fresh secret such as ]x.
  if (values.every((candidate) =>
    !base.includes(candidate) && !candidate.includes("[") && !candidate.includes("]"),
  )) {
    return base;
  }
  const pool = ["•", "*", "#", "×", "▪", "·", "‡", "�"];
  const characters = new Set(values.flatMap((candidate) => Array.from(candidate)));
  let maskChar = pool.find((c) => !characters.has(c));
  // The usual mask alphabet may itself consist of protected one-character
  // values. Search the remaining Unicode scalars rather than fall back to a
  // known secret. If no safe scalar exists, refuse redaction without output.
  for (let code = 0xa1; maskChar === undefined && code <= 0x10ffff; code += 1) {
    if (code >= 0xd800 && code <= 0xdfff) continue;
    const candidate = String.fromCodePoint(code);
    if (!characters.has(candidate)) maskChar = candidate;
  }
  if (maskChar === undefined) throw new Error("No safe redaction placeholder is available");
  return maskChar.repeat(Math.min(Math.max(value.length, 8), 24));
}

/**
 * Boundary-safe redaction state. Feed it decoded text with `push()`; it returns
 * the text that is safe to emit now, holding back the final
 * `maxSecretValueLength - 1` characters in case a value straddles the boundary.
 * Call `flush()` exactly once, after every contributing stream has ended, to
 * release the held tail.
 *
 * A SINGLE engine can be shared across several streams (e.g. a child's stdout
 * AND stderr). Because the held-back tail is shared, a secret split half-to-
 * stdout / half-to-stderr — which a naive per-stream redactor would reassemble
 * in a combined capture — is still caught. Node is single-threaded, so the
 * `push()` calls from different streams never interleave mid-scan.
 */
export class RedactionEngine {
  private readonly targets: { value: string; placeholder: string }[];
  private readonly keep: number;
  private pending = "";

  constructor(targets: readonly RedactionTarget[]) {
    const values = targets.map((target) => target.value);
    // Drop empty values (a "" match would explode into every gap). Sort
    // longest-first so a value that is a substring of another is redacted by
    // its most specific (longest) match before the shorter one runs.
    this.targets = targets
      .filter((t) => t.value.length > 0)
      .sort((a, b) => b.value.length - a.value.length)
      .map((t) => ({ value: t.value, placeholder: placeholderForValues(t.name, t.value, values) }));
    const maxLen = this.targets.reduce((m, t) => Math.max(m, t.value.length), 0);
    this.keep = Math.max(0, maxLen - 1);
  }

  private redact(input: string): string {
    let out = input;
    for (const t of this.targets) out = out.split(t.value).join(t.placeholder);
    return out;
  }

  /** Feed decoded text; get back the prefix that is safe to emit right now. */
  push(text: string): string {
    if (text === "") return "";
    const redacted = this.redact(this.pending + text);
    let emitUpto = Math.max(0, redacted.length - this.keep);
    // Never split a UTF-16 surrogate pair across the emit boundary: if the last
    // emitted unit is a high surrogate, hold it back with its (future) low half.
    if (emitUpto > 0 && emitUpto < redacted.length) {
      const code = redacted.charCodeAt(emitUpto - 1);
      if (code >= 0xd800 && code <= 0xdbff) emitUpto -= 1;
    }
    this.pending = redacted.slice(emitUpto);
    return redacted.slice(0, emitUpto);
  }

  /** Release the held tail. Call once, after all contributing streams end. */
  flush(): string {
    const tail = this.redact(this.pending);
    this.pending = "";
    return tail;
  }
}

/**
 * A Transform that redacts a single stream. This is the last line of the
 * agent-safety guarantee: even if a child echoes a secret, the calling agent
 * only ever sees `[redacted:NAME]`. A `StringDecoder` keeps multi-byte UTF-8
 * characters intact across chunk boundaries. For cross-stream safety (stdout +
 * stderr sharing one held-back tail) the runner drives a single
 * `RedactionEngine` directly instead of two of these.
 */
export class Redactor extends Transform {
  private readonly engine: RedactionEngine;
  private readonly decoder = new StringDecoder("utf8");

  constructor(targets: readonly RedactionTarget[]) {
    super();
    this.engine = new RedactionEngine(targets);
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    callback(null, this.engine.push(this.decoder.write(buf)));
  }

  override _flush(callback: TransformCallback): void {
    const out = this.engine.push(this.decoder.end()) + this.engine.flush();
    callback(null, out);
  }
}
