import test from "node:test";
import assert from "node:assert/strict";
import { compactConversationDeterministic } from "../src/compaction.js";

test("compactConversationDeterministic preserves requirements paths and tool outcomes", () => {
  const messages = [
    { role: "user", content: "Fix src/app.js and run npm test" },
    { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file" } }] },
    { role: "tool", name: "read_file", content: "   1 export function app() {}\n" },
    { role: "tool", name: "shell", content: "backend=local cmd=npm test\nall passed" },
    { role: "user", content: "continue" },
    { role: "assistant", content: "working" }
  ];
  for (let index = 0; index < 10; index += 1) {
    messages.push({ role: "user", content: `follow-up-${index}` });
    messages.push({ role: "assistant", content: `ack-${index}` });
  }

  const compacted = compactConversationDeterministic(messages, {
    keepRecent: 4,
    todoState: "Workspace todos:\n- todo_1 (pending) ship fix"
  });

  assert.equal(compacted.length, 5);
  assert.match(compacted[0].content, /User requirements preserved/);
  assert.match(compacted[0].content, /src\/app\.js/);
  assert.match(compacted[0].content, /npm test/);
  assert.match(compacted[0].content, /Workspace todos/);
  assert.match(compacted[0].content, /\[read_file\]/);
  assert.equal(compacted.at(-1).content, "ack-9");
});