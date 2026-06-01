import test from "node:test";
import assert from "node:assert/strict";
import { applyShortcut, trimConversation } from "../src/tui.js";

test("trimConversation starts retained context at a user boundary", () => {
  const messages = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "assistant", content: "tool request" },
    { role: "tool", content: "tool output" },
    { role: "user", content: "recent question" },
    { role: "assistant", content: "recent answer" }
  ];
  const trimmed = trimConversation(messages, 3);
  assert.deepEqual(trimmed, messages.slice(4));
  assert.equal(trimmed[0].role, "user");
});

test("trimConversation leaves short conversations untouched", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(trimConversation(messages), messages);
});

test("applyShortcut rotates reasoning and mode without persistence when requested", () => {
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  const events = [];
  const options = { persist: false, notify: (message) => events.push(message) };
  applyShortcut({ name: "tab" }, state, options);
  applyShortcut({ name: "tab", shift: true }, state, options);
  assert.equal(state.cfg.reasoning, "high");
  assert.equal(state.mode, "always-approve");
  assert.deepEqual(events, ["reasoning: high", "mode: always-approve"]);
});
