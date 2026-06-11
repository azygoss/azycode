import test from "node:test";
import assert from "node:assert/strict";
import { compactConversationWithModel } from "../src/compaction.js";

test("compactConversationWithModel summarizes old turns and keeps recent messages", async () => {
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `message-${index}` });
  }
  const client = {
    chat: async ({ messages: requestMessages }) => {
      const user = requestMessages.find((message) => message.role === "user")?.content || "";
      assert.match(user, /message-0/);
      assert.match(user, /message-7/);
      return {
        choices: [{ message: { role: "assistant", content: "Prior work focused on harness wiring." } }]
      };
    }
  };

  const compacted = await compactConversationWithModel({
    client,
    messages,
    model: "mock",
    keepRecent: 8
  });
  assert.equal(compacted.length, 10);
  assert.match(compacted[0].content, /Earlier conversation summary/);
  assert.match(compacted[0].content, /Prior work focused on harness wiring/);
  assert.equal(compacted.at(-1).content, "message-19");
});

test("compactConversationWithModel leaves short conversations untouched", async () => {
  const messages = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" }
  ];
  let called = false;
  const client = { chat: async () => { called = true; return { choices: [] }; } };
  const compacted = await compactConversationWithModel({ client, messages, model: "mock", keepRecent: 8 });
  assert.deepEqual(compacted, messages);
  assert.equal(called, false);
});