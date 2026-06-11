import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AGENT_EVENT_TYPES,
  createAgentProgress,
  createEventCollector,
  formatAgentEvent,
  formatAgentRunReport,
  formatAgentStepLine,
  formatSessionEvents,
  formatSessionTranscript,
  extractToolPreview,
  formatAgentRunStats,
  formatAgentRunSummary,
  formatAgentStepExtras,
  formatToolPreviewLines,
  formatToolRunLine,
  formatSessionCreated,
  hasActiveProvider,
  READ_ONLY_TOOLS,
  isKnownAgentEvent,
  runtimeSnapshot,
  sessionListEntries,
  summarizeAgentRun,
  summarizeToolArgs,
  toolRunListEntries
} from "../src/harness.js";
import { stripAnsi } from "../src/ui.js";
import { AgentCancelledError, AgentStepLimitError as StepLimitError } from "../src/agent-errors.js";

test("hasActiveProvider requires configured credentials", () => {
  assert.equal(hasActiveProvider({ activeProvider: "kimi", providers: { kimi: { apiKey: "sk-test" } } }), true);
  assert.equal(hasActiveProvider({ activeProvider: "kimi", providers: { byok: { baseUrl: "http://127.0.0.1:11434/v1" } } }), false);
  assert.equal(hasActiveProvider({ activeProvider: "byok", providers: { byok: { baseUrl: "http://127.0.0.1:11434/v1" } } }), false);
  assert.equal(hasActiveProvider({ activeProvider: "byok", providers: { byok: { baseUrl: "http://127.0.0.1:11434/v1", apiKey: "local" } } }), true);
  assert.equal(hasActiveProvider({ providers: { kimi: { apiKey: "sk-test" } } }), false);
});

test("summarizeToolArgs highlights common tool parameters", () => {
  assert.equal(summarizeToolArgs("read_file", { file: "src/a.js" }), "src/a.js");
  assert.equal(summarizeToolArgs("read_file", { file: "src/a.js", startLine: 10, endLine: 20 }), "src/a.js:10-20");
  assert.equal(summarizeToolArgs("read_many_files", { files: ["a.js", "b.js"] }), "2 files");
  assert.equal(summarizeToolArgs("shell", { command: "npm test" }), "npm test");
  assert.equal(summarizeToolArgs("search", { query: "tab shortcut", dir: "src" }), "tab shortcut in src");
  assert.equal(summarizeToolArgs("copy_path", { from: "a.js", to: "b.js" }), "a.js → b.js");
  assert.equal(summarizeToolArgs("git_checkout", { branch: "feat/x", create: true }), "feat/x (create)");
  assert.equal(summarizeToolArgs("todo", { action: "add", text: "ship harness" }), "add ship harness");
  assert.equal(summarizeToolArgs("set_mode", { mode: "plan", reason: "inspect first" }), "plan · inspect first");
  assert.equal(summarizeToolArgs("spawn_subagents", { tasks: [{ agent: "reviewer", prompt: "x" }, { agent: "explorer", prompt: "y" }] }), "2 tasks · reviewer, explorer");
  assert.equal(summarizeToolArgs("git_worktree", { action: "add", name: "feat-a", branch: "feat/a" }), "add feat-a feat/a");
  assert.equal(summarizeToolArgs("read_file", { path: "legacy.js" }), "");
  assert.equal(summarizeToolArgs("tool", null), "");
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

test("formatAgentEvent covers model_end in tui style", () => {
  const line = formatAgentEvent({
    type: "model_end",
    step: 2,
    toolCalls: 2,
    tools: ["read_file", "search"]
  }, { style: "tui" });
  assert.match(line, /tools \(2\)/);
  assert.match(line, /read_file, search/);
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

test("formatAgentStepLine renders new lifecycle events", () => {
  const end = formatAgentStepLine({ type: "agent_run_end", step: 3, status: "ok", durationMs: 1500 }, { style: "cli" });
  assert.match(end, /run end · ok/);
  assert.match(end, /1500ms/);

  const budget = formatAgentStepLine({ type: "step_budget_low", step: 11, maxSteps: 12, remaining: 1 });
  assert.match(budget, /step budget low/);

  const mode = formatAgentStepLine({ type: "mode_change", step: 2, mode: "plan", reason: "inspect" }, { style: "cli" });
  assert.match(mode, /mode -> plan \(inspect\)/);

  const failed = formatAgentStepLine({
    type: "tool_end",
    step: 1,
    tool: "shell",
    ok: false,
    code: "rejected",
    durationMs: 4,
    errorPreview: "Tool call rejected by user."
  }, { style: "cli" });
  assert.match(failed, /rejected/);

  const trim = formatAgentStepLine({ type: "context_trim", step: 5, before: 40, after: 20 });
  assert.match(trim, /context trimmed 40→20/);

  const compact = formatAgentStepLine({ type: "context_compact", step: 6, before: 50, after: 14, method: "llm" });
  assert.match(compact, /context compacted \(llm\) 50→14/);

  const subStart = formatAgentStepLine({ type: "subagent_start", step: 2, agent: "reviewer" });
  assert.match(subStart, /subagent start reviewer/);

  const subEnd = formatAgentStepLine({ type: "subagent_end", step: 2, agent: "reviewer", ok: true, durationMs: 900 });
  assert.match(subEnd, /subagent end · reviewer · ok/);

  const missionStart = formatAgentStepLine({ type: "mission_start", missionId: "mis_1", name: "parallel-review", steps: 3 });
  assert.match(missionStart, /mission start · parallel-review · 3 steps/);

  const missionStep = formatAgentStepLine({ type: "mission_step_start", step: 2, id: "parallel-review", parallel: 2 });
  assert.match(missionStep, /parallel-review start · 2 parallel/);
});

test("formatAgentRunReport joins step lines with style", () => {
  const events = [
    { type: "model_start", step: 1, maxSteps: 12, mode: "plan", model: "mock" },
    { type: "tool_start", step: 1, maxSteps: 12, tool: "search", summary: "tab" }
  ];
  const tui = formatAgentRunReport(events, { maxSteps: 12, style: "tui" });
  const cli = formatAgentRunReport(events, { maxSteps: 12, style: "cli" });
  assert.match(tui, /Step 1\/12/);
  assert.match(cli, /Step 1\/12: model/);
  assert.match(cli, /search/);
});

test("AgentStepLimitError includes step report", () => {
  const error = new StepLimitError({
    maxSteps: 12,
    events: [{ type: "model_start", step: 1, maxSteps: 12, mode: "plan", model: "mock" }],
    partialContent: "partial plan"
  });
  assert.match(error.message, /12 steps/);
  assert.match(error.report, /Step 1\/12/);
  assert.equal(error.partialContent, "partial plan");
});

test("AgentStepLimitError respects cli style", () => {
  const error = new StepLimitError({
    maxSteps: 4,
    style: "cli",
    events: [{ type: "tool_end", step: 4, tool: "read_file", ok: true, durationMs: 12 }]
  });
  assert.match(error.report, /12ms/);
  assert.doesNotMatch(error.report, /←/);
});

test("runtimeSnapshot aggregates guard and policy counts", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-harness-"));
  process.env.AZYCODE_HOME = home;
  const snap = runtimeSnapshot({
    mode: "plan",
    reasoning: "medium",
    activeProvider: "byok",
    activeModel: "local",
    providers: { byok: { apiKey: "sk" } },
    toolPolicy: { shell: "ask", read_file: "auto", write_file: "deny" },
    skills: { lint: { text: "lint" } },
    subagents: { impl: { system: "go" } }
  }, "/tmp/project");
  assert.equal(snap.providerReady, true);
  assert.equal(snap.policy.auto, 1);
  assert.equal(snap.policy.ask, 1);
  assert.equal(snap.policy.deny, 1);
  assert.equal(snap.cwd, "/tmp/project");
  assert.equal(snap.counts.skills, 1);
  assert.equal(snap.counts.subagents, 1);
});

test("summarizeAgentRun computes run stats", () => {
  const stats = summarizeAgentRun([
    { type: "model_end", step: 2, toolCalls: 2, durationMs: 1000 },
    { type: "tool_end", ok: true, durationMs: 50 },
    { type: "tool_end", ok: false, durationMs: 25 },
    { type: "final", step: 2 }
  ]);
  assert.equal(stats.steps, 2);
  assert.equal(stats.toolCalls, 2);
  assert.equal(stats.toolFailures, 1);
  assert.equal(stats.totalModelMs, 1000);
  assert.equal(stats.totalToolMs, 75);
  assert.equal(stats.status, "ok");
});

test("formatSessionEvents and transcript helpers", () => {
  const events = [
    { type: "agent_run_start", step: 0, mode: "plan", model: "mock" },
    { type: "final", step: 1 }
  ];
  assert.match(formatSessionEvents(events, { style: "cli" }), /run start/);
  const transcript = formatSessionTranscript({
    prompt: "fix harness",
    events,
    messages: [{ role: "user", content: "fix harness" }]
  });
  assert.match(transcript, /prompt: fix harness/);
  assert.match(transcript, /events:/);
});

test("createEventCollector and isKnownAgentEvent", () => {
  const collector = createEventCollector();
  collector.onEvent({ type: "final", step: 1 });
  assert.equal(collector.events.length, 1);
  assert.equal(isKnownAgentEvent({ type: "final" }), true);
  assert.equal(isKnownAgentEvent({ type: "nope" }), false);
  assert.equal(AGENT_EVENT_TYPES.includes("agent_run_end"), true);
  assert.equal(AGENT_EVENT_TYPES.includes("context_compact"), true);
  assert.equal(AGENT_EVENT_TYPES.includes("subagent_start"), true);
});

test("formatAgentRunSummary condenses lifecycle stats", () => {
  const summary = formatAgentRunSummary([
    { type: "model_end", step: 2, toolCalls: 3, durationMs: 900, usage: { total_tokens: 1200 } },
    { type: "tool_end", ok: true, durationMs: 40 },
    { type: "tool_end", ok: false, durationMs: 10 },
    { type: "final", step: 2 },
    { type: "agent_run_end", status: "ok", durationMs: 2500 }
  ], { style: "cli" });
  assert.match(summary, /ok/);
  assert.match(summary, /2 steps/);
  assert.match(summary, /3 tools/);
  assert.match(summary, /1 failed/);
  assert.match(summary, /2500ms/);
  assert.match(summary, /1200 tok/);
});

test("READ_ONLY_TOOLS marks inspection tools", () => {
  assert.equal(READ_ONLY_TOOLS.has("read_file"), true);
  assert.equal(READ_ONLY_TOOLS.has("write_file"), false);
});

test("formatToolRunLine summarizes stored tool runs", () => {
  const line = formatToolRunLine({
    name: "read_file",
    args: { file: "src/harness.js" },
    ok: true,
    durationMs: 42
  }, { style: "cli" });
  assert.match(line, /read_file src\/harness.js/);
  assert.match(line, /ok/);
  assert.match(line, /42ms/);
});

test("withAgentAbort exposes a signal and cleans up listeners", async () => {
  const { withAgentAbort } = await import("../src/harness.js");
  let seenSignal = null;
  await withAgentAbort(async (signal) => {
    seenSignal = signal;
    assert.equal(signal.aborted, false);
  });
  assert.ok(seenSignal);
});

test("AgentCancelledError is an AgentRunError with report", () => {
  const error = new AgentCancelledError({
    events: [{ type: "agent_run_start", step: 0, mode: "plan" }],
    style: "cli"
  });
  assert.equal(error.name, "AgentCancelledError");
  assert.match(error.report, /run start/);
});

test("extractToolPreview surfaces file and diff previews", () => {
  const file = extractToolPreview("write_file", { file: "src/a.js" }, "line1\nline2");
  assert.equal(file.kind, "file");
  assert.equal(file.file, "src/a.js");
  assert.equal(file.added, 2);

  const diff = extractToolPreview("git_diff", {}, "+++ a\n--- b\n@@\n+added\n-removed\n");
  assert.equal(diff.kind, "diff");
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.lines.length, 2);
});

test("formatAgentStepExtras renders diff preview lines for rich tool_end", () => {
  const extras = formatAgentStepExtras({
    type: "tool_end",
    ok: true,
    preview: { kind: "diff", lines: ["+added", "-removed"], added: 1, removed: 1 }
  }, { style: "rich", width: 60 });
  assert.ok(extras.length >= 2);
  assert.match(extras.join("\n"), /\+added/);
  assert.match(extras.join("\n"), /-removed/);
});

test("formatToolPreviewLines renders file change badges", () => {
  const lines = formatToolPreviewLines({ kind: "file", file: "src/a.js", added: 4, removed: 1 }, { width: 50 });
  assert.ok(lines.length >= 1);
  const plain = lines.join("\n");
  assert.match(plain, /src\/a\.js/);
  assert.match(plain, /\+4/);
});

test("formatAgentStepLine rich style color-codes tool activity", () => {
  const line = formatAgentStepLine({
    type: "tool_end",
    step: 2,
    maxSteps: 8,
    tool: "read_file",
    ok: true,
    durationMs: 25,
    summary: "src/tui.js"
  }, { style: "rich" });
  assert.match(line, /read_file/);
  assert.match(line, /Step 2\/8/);
  assert.match(line, /src\/tui\.js/);
});

test("formatAgentRunStats exposes panel-friendly values", () => {
  const stats = formatAgentRunStats([
    { type: "model_end", step: 2, toolCalls: 1, durationMs: 500, usage: { total_tokens: 200 } },
    { type: "final", step: 2 },
    { type: "agent_run_end", status: "ok", durationMs: 1200 }
  ]);
  assert.equal(stats.status, "ok");
  assert.equal(stats.steps, 2);
  assert.equal(stats.toolCalls, 1);
  assert.equal(stats.tokens, 200);
  assert.equal(stats.duration, "1.2s");
});

test("createAgentProgress invokes onLine with event", () => {
  const lines = [];
  const progress = createAgentProgress({
    style: "cli",
    onLine: (line, event) => lines.push({ line, type: event.type })
  });
  progress({ type: "tool_start", step: 1, maxSteps: 5, tool: "search", summary: "harness" });
  assert.equal(lines.length, 1);
  assert.match(lines[0].line, /search/);
  assert.equal(lines[0].type, "tool_start");
});

test("formatAgentStepLine grok style renders diamond action rows", () => {
  const line = stripAnsi(formatAgentStepLine({
    type: "tool_end",
    step: 1,
    tool: "read_file",
    ok: true,
    durationMs: 25,
    summary: "src/ui.js"
  }, { style: "grok", width: 80 }));
  assert.match(line, /Read/);
  assert.match(line, /src\/ui\.js/);
});

test("createAgentProgress rich style skips noisy tool_start rows", () => {
  const lines = [];
  const progress = createAgentProgress({
    style: "rich",
    onLine: (line, event) => lines.push({ line, type: event.type })
  });
  progress({ type: "tool_start", step: 1, maxSteps: 5, tool: "search", summary: "harness" });
  progress({ type: "tool_end", step: 1, maxSteps: 5, tool: "search", ok: true, durationMs: 12 });
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "tool_end");
  assert.match(lines[0].line, /search/);
});

test("formatSessionCreated shows relative age for recent timestamps", () => {
  const recent = formatSessionCreated(new Date(Date.now() - 5 * 60 * 1000).toISOString());
  assert.match(recent, /ago$/);
  assert.equal(formatSessionCreated(""), "");
});

test("sessionListEntries sorts by createdAt and uses summarizeAgentRun status", () => {
  const older = new Date(Date.now() - 60_000).toISOString();
  const newer = new Date().toISOString();
  const rows = sessionListEntries({
    ses_old: {
      mode: "plan",
      prompt: "older task",
      createdAt: older,
      stopped: "cancelled"
    },
    ses_new: {
      mode: "goal",
      prompt: "ship it",
      createdAt: newer,
      events: [
        { type: "model_end", step: 1, toolCalls: 1, durationMs: 400 },
        { type: "tool_end", step: 1, tool: "read_file", ok: true, durationMs: 12 },
        { type: "agent_run_end", step: 1, status: "ok", durationMs: 1200 }
      ]
    }
  }, { promptLimit: 20 });
  assert.equal(rows[0].id, "ses_new");
  assert.equal(rows[0].mode, "goal");
  assert.equal(rows[0].status, "ok");
  assert.equal(rows[0].steps, 1);
  assert.equal(rows[0].tools, 1);
  assert.equal(rows[1].id, "ses_old");
  assert.equal(rows[1].status, "cancelled");
  assert.equal(rows[1].prompt, "older task");
});

test("toolRunListEntries returns newest runs first with summaries", () => {
  const rows = toolRunListEntries([
    { name: "read_file", ok: true, durationMs: 3, sessionId: "ses_a", step: 1, args: { file: "a.js" } },
    { name: "search", ok: false, durationMs: 9, sessionId: "ses_b", step: 2, args: { query: "harness" } }
  ], { limit: 10 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, "search");
  assert.equal(rows[0].summary, "harness");
  assert.equal(rows[0].ok, "failed");
  assert.equal(rows[1].tool, "read_file");
  assert.equal(rows[1].summary, "a.js");
  assert.equal(rows[1].ok, "ok");
});