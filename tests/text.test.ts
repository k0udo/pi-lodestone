import { strict as assert } from "node:assert";
import { test } from "node:test";
import { capOutput, clampNumber, excerpt, textFromContent } from "../extension/text.ts";

test("textFromContent handles strings, text blocks, and ignores non-text", () => {
  assert.equal(textFromContent("hello"), "hello");
  assert.equal(textFromContent([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(textFromContent(undefined), "");
  assert.equal(textFromContent(42), "");
});

test("clampNumber falls back, floors, and bounds", () => {
  assert.equal(clampNumber(undefined, 5, 1, 10), 5);
  assert.equal(clampNumber(7.9, 5, 1, 10), 7);
  assert.equal(clampNumber(0, 5, 1, 10), 1);
  assert.equal(clampNumber(99, 5, 1, 10), 10);
  assert.equal(clampNumber("nope", 5, 1, 10), 5);
});

test("capOutput truncates with a marker only when over the limit", () => {
  assert.equal(capOutput("short", 100), "short");
  const capped = capOutput("abcdefghij", 5);
  assert.match(capped, /^abcde/);
  assert.match(capped, /truncated by memory-get at 5 chars/);
});

test("excerpt returns the whole string when within budget", () => {
  assert.equal(excerpt("  spaced   out  ", "x", 100), "spaced out");
});

test("excerpt centers the window on the earliest query match", () => {
  const body = `${"x".repeat(80)} needle ${"y".repeat(80)}`;
  const out = excerpt(body, "needle", 40);
  assert(out.includes("needle"));
  assert(out.length <= 42); // 40 + ellipses
});
