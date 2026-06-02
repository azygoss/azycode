import test from "node:test";
import assert from "node:assert/strict";
import { formatAgentEvent, hasActiveProvider, runtimeSnapshot, summarizeToolArgs } from "../src/harness.js";

test("hasActiveProvider requires configured credentials", () => {
  assert.equal(hasActiveProvider({ activeProvider: "kimi", providers: { kimi: { apiKey: "sk-test" } } }), true);
  assert.equal(hasActiveProvider({ activeProvider: "kimi", providers: {} }), false);
  assert.equal(hasActiveProvider({ providers: { kimi: { apiKey: "sk-test" } } }), false);
});

test("summarizeToolArgs highlights common tool parameters", () => {
  assert.equal(summarizeToolArgs("read_file", { path: "src/a.js" }), "src/a.js");
  assert.equal(summarizeToolArgs("shell", { command: "npm test" }), "npm test");
  assert.equal(summarizeToolArgs("search", { query: "tab shortcut" }), "tab shortcut");
});

test("formatAgentEvent includes tool summaries in cli style", () => {
  const line = formatAgentEvent({
    type: "tool_start",
    sessionId: "ses_test",
    step: 2,
    tool: "read_file",
    summary: "src/tui.js"
  }, { style: "cli" });
  assert.match(line, /read_file src\/tui.js/);
});

test("runtimeSnapshot aggregates guard and policy counts", () => {
  const snap = runtimeSnapshot({
    mode: "plan",
    reasoning: "medium",
    activeProvider: "byok",
    activeModel: "local",
    providers: { byok: { apiKey: "sk" } },
    toolPolicy: { shell: "ask", read_file: "auto", write_file: "deny" }
  });
  assert.equal(snap.providerReady, true);
  assert.equal(snap.policy.auto, 1);
  assert.equal(snap.policy.ask, 1);
  assert.equal(snap.policy.deny, 1);
});