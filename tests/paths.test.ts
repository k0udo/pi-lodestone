import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { resolveProjectPath } from "../extension/paths.ts";

test("resolveProjectPath preserves absolute paths", () => {
  assert.equal(resolveProjectPath("/repos/current", "/Users/koudo/Notebook"), "/Users/koudo/Notebook");
});

test("resolveProjectPath resolves relative paths against cwd", () => {
  assert.equal(resolveProjectPath("/repos/current", "docs"), "/repos/current/docs");
});

test("resolveProjectPath expands home paths", () => {
  assert.equal(resolveProjectPath("/repos/current", "~"), homedir());
  assert.equal(resolveProjectPath("/repos/current", "~/Notebook"), join(homedir(), "Notebook"));
});

test("resolveProjectPath defaults to cwd", () => {
  assert.equal(resolveProjectPath("/repos/current", undefined), resolve("/repos/current"));
  assert.equal(resolveProjectPath("/repos/current", "   "), resolve("/repos/current"));
});
