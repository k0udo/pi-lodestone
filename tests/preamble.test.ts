import { strict as assert } from "node:assert";
import { test } from "node:test";
import { applyUserPreamble } from "../extension/preamble.ts";

test("applyUserPreamble prefixes only the latest user message and does not mutate input", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "old request" }], timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
    { role: "user", content: [{ type: "text", text: "new request" }], timestamp: 3 },
  ];
  const next = applyUserPreamble(messages, "## Pi memory (verify)\n- [m1] Memory") as any[];
  // input untouched
  assert.equal((messages[2].content[0] as any).text, "new request");
  // earlier user message untouched
  assert.equal((next[0].content[0] as any).text, "old request");
  // latest user message prefixed
  assert.match((next[2].content[0] as any).text, /^## Pi memory \(verify\)/);
  assert.match((next[2].content[0] as any).text, /## User request\nnew request/);
});

test("applyUserPreamble handles string content", () => {
  const messages = [{ role: "user", content: "hello" }];
  const next = applyUserPreamble(messages, "PRE") as any[];
  assert.match(next[0].content, /^PRE\n\n## User request\nhello$/);
});

test("applyUserPreamble is idempotent when content already starts with the preamble", () => {
  const messages = [{ role: "user", content: "PRE already here" }];
  const next = applyUserPreamble(messages, "PRE") as any[];
  assert.equal(next[0].content, "PRE already here");
});

test("applyUserPreamble returns input unchanged for empty preamble or no user message", () => {
  const messages = [{ role: "assistant", content: "x" }];
  assert.equal(applyUserPreamble(messages, ""), messages);
  assert.equal(applyUserPreamble(messages, "PRE"), messages);
});

test("applyUserPreamble inserts a text block when the latest user message has none", () => {
  const messages = [{ role: "user", content: [{ type: "image", source: {} }] }];
  const next = applyUserPreamble(messages, "PRE") as any[];
  assert.equal(next[0].content[0].type, "text");
  assert.match(next[0].content[0].text, /^PRE\n\n## User request$/);
});
