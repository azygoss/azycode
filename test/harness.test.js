import test from "node:test";
import assert from "node:assert/strict";
import { formatAgentEvent, formatAgentRunReport, formatAgentStepLine, hasActiveProvider, runtimeSnapshot, summarizeToolArgs } from "../src/harness.js";
import { AgentStepLimitError } from "../src/agent-errors.js";

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

test("formatAgentStepLine prints explicit step numbers", () => {
  const line = formatAgentStepLine({
    type: "tool_start",
    step: 4,
    maxSteps: 24,
    tool: "read_file",
    summary: "src/agent.js"
  });
  assert.match(line, /Step 4\/24/);
  assert.match(line, /read_file/);
});

test("formatAgentRunReport joins step lines", () => {
  const report = formatAgentRunReport([
    { type: "model_start", step: 1, maxSteps: 12, mode: "plan", model: "mock" },
    { type: "tool_start", step: 1, maxSteps: 12, tool: "search", summary: "tab" }
  ], { maxSteps: 12 });
  assert.match(report, /Step 1\/12/);
  assert.match(report, /search/);
});

test("AgentStepLimitError includes step report", () => {
  const error = new AgentStepLimitError({
    maxSteps: 12,
    events: [{ type: "model_start", step: 1, maxSteps: 12, mode: "plan", model: "mock" }],
    partialContent: "partial plan"
  });
  assert.match(error.message, /12 steps/);
  assert.match(error.report, /Step 1\/12/);
  assert.equal(error.partialContent, "partial plan");
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