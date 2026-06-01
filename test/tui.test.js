import test from "node:test";
import assert from "node:assert/strict";
import { trimConversation } from "../src/tui.js";

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
