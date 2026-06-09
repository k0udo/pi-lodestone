import { strict as assert } from "node:assert";
import { test } from "node:test";
import { maskSecrets, sanitize, stripPrivate } from "../extension/sanitize.ts";

test("stripPrivate replaces <private> blocks with a placeholder", () => {
  assert.equal(stripPrivate("keep <private>secret</private> end"), "keep [private omitted] end");
  assert.equal(stripPrivate("a <PRIVATE>x\ny</PRIVATE> b"), "a [private omitted] b");
  assert.equal(stripPrivate("no tags here"), "no tags here");
});

test("maskSecrets redacts common token patterns", () => {
  assert.match(maskSecrets("API_KEY=abc123"), /API_KEY=\[redacted\]/);
  assert.match(maskSecrets("export SECRET_TOKEN = xyz"), /SECRET_TOKEN=\[redacted\]/);
  assert.match(maskSecrets("Authorization: Bearer abc.def.ghi"), /Bearer \[redacted\]/);
  assert.match(maskSecrets("sk-abcdefghijklmnop1234567"), /sk-\[redacted\]/);
});

test("sanitize masks secrets, strips private blocks, and trims", () => {
  const text = sanitize("  keep <private>secret-token</private> API_KEY=abc Bearer abc.def sk-abcdefghijklmnop1234567  ");
  assert(!text.includes("secret-token"));
  assert(text.includes("[private omitted]"));
  assert(text.includes("API_KEY=[redacted]"));
  assert(text.includes("Bearer [redacted]"));
  assert(text.includes("sk-[redacted]"));
  assert.equal(text, text.trim());
});

test("sanitize enforces the max-length cap", () => {
  assert.equal(sanitize("abcdef", 3), "abc");
  assert.equal(sanitize("abc", 10), "abc");
});
