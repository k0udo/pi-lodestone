import { strict as assert } from "node:assert";
import { test } from "node:test";
import { PROJECT_PACKET_INJECT, PROJECT_PACKET_MAX_CHARS } from "../extension/config.ts";

test("project packet injection is disabled by default", () => {
  assert.equal(PROJECT_PACKET_INJECT, false);
  assert.equal(PROJECT_PACKET_MAX_CHARS, 1_200);
});
