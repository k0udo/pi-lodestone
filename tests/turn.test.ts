import { strict as assert } from "node:assert";
import { test } from "node:test";
import { compactTurnText, decisionStatementFromTurn, hasDurableSignal } from "../extension/turn.ts";

test("hasDurableSignal accepts durable phrasing and rejects chatter", () => {
  assert.equal(hasDurableSignal("we decided to ship phase 4"), true);
  assert.equal(hasDurableSignal("always prefer the local model"), true);
  assert.equal(hasDurableSignal("what time is it"), false);
  assert.equal(hasDurableSignal("looks good, thanks"), false);
});

test("decisionStatementFromTurn prefers durable lines within length bounds", () => {
  const text = "User:\nLet's keep memory recovery semi-automatic with a human review gate.";
  assert.match(decisionStatementFromTurn(text) ?? "", /semi-automatic/);
});

test("decisionStatementFromTurn ignores too-short and non-durable lines", () => {
  assert.equal(decisionStatementFromTurn("User:\nok"), undefined);
  assert.equal(decisionStatementFromTurn("User:\nplease run the tests again for me right now"), undefined);
});

test("compactTurnText extracts the last user/assistant text and sanitizes it", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "user", content: [{ type: "text", text: "remember API_KEY=topsecret in the workflow" }] },
    { role: "assistant", content: [{ type: "text", text: "Noted the decision." }] },
  ];
  const { userText, assistantText, text } = compactTurnText(messages);
  assert.match(userText, /remember/);
  assert.equal(assistantText, "Noted the decision.");
  assert.match(text, /User:/);
  assert.match(text, /Assistant:/);
  assert.match(text, /API_KEY=\[redacted\]/);
  assert(!text.includes("topsecret"));
});
