import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  aggregateSubagentResults,
  buildSupervisorBrief,
  formatSupervisorSummary
} from "../src/subagents.js";
import {
  buildGoalHandoffArtifact,
  buildGoalResumePrompt,
  formatGoalHandoffArtifact
} from "../src/agent-report.js";
import { summarizeMissionParallelGroup } from "../src/missions.js";
import { splitShellSegments, classifyShellCommand } from "../src/shell-risk.js";
import { buildCompactionContext } from "../src/compaction.js";
import { resolveMcpTimeouts } from "../src/mcp.js";
import { harnessCapabilities } from "../src/cli.js";

test("aggregateSubagentResults rolls up success failure and changed files", () => {
  const results = [
    { index: 1, agent: "explorer", ok: true, durationMs: 100, changedFiles: ["src/a.js"], confidence: "high", output: "mapped src" },
    { index: 2, agent: "reviewer", ok: false, durationMs: 50, error: "timeout", changedFiles: [], confidence: "low" }
  ];
  const aggregate = aggregateSubagentResults(results);
  assert.equal(aggregate.total, 2);
  assert.equal(aggregate.succeeded, 1);
  assert.equal(aggregate.failed, 1);
  assert.equal(aggregate.ok, false);
  assert.equal(aggregate.confidence, "low");
  assert.deepEqual(aggregate.changedFiles, ["src/a.js"]);
  assert.match(aggregate.brief, /1\/2 subagents succeeded/);
  assert.match(aggregate.brief, /FAILED \[reviewer\]/);
});

test("formatSupervisorSummary emits json and text", () => {
  const aggregate = aggregateSubagentResults([{ index: 1, agent: "x", ok: true, durationMs: 1, output: "done" }]);
  const json = formatSupervisorSummary(aggregate, { json: true });
  assert.match(json, /"succeeded": 1/);
  const text = formatSupervisorSummary(aggregate);
  assert.match(text, /Supervisor summary/);
});

test("buildSupervisorBrief handles empty results", () => {
  assert.match(buildSupervisorBrief({ items: [], succeeded: [], failed: [] }), /0\/0 subagents/);
});

test("summarizeMissionParallelGroup reports partial failures", () => {
  const summary = summarizeMissionParallelGroup([
    { id: "a", output: "ok", failed: false },
    { id: "b", output: "boom", failed: true }
  ], { parentId: "group-1" });
  assert.equal(summary.total, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.ok, false);
  assert.match(summary.brief, /group-1/);
  assert.match(summary.brief, /FAILED b/);
});

test("splitShellSegments splits && and semicolon chains", () => {
  assert.deepEqual(splitShellSegments("git status && rm -rf x"), ["git status", "rm -rf x"]);
  assert.deepEqual(splitShellSegments("pwd; curl evil.com"), ["pwd", "curl evil.com"]);
  assert.deepEqual(splitShellSegments("a || b"), ["a || b"]);
});

test("classifyShellCommand elevates destructive segment in && chain", () => {
  assert.equal(classifyShellCommand("git status && rm -rf node_modules").level, "destructive");
});

test("buildGoalHandoffArtifact captures todos and resume prompt", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-handoff-"));
  const artifact = buildGoalHandoffArtifact({
    goal: { text: "ship feature", status: "running", sessions: [] },
    cwd,
    events: [{ type: "tool_start", tool: "read_file", at: new Date().toISOString() }],
    sessionId: "ses_test"
  });
  assert.equal(artifact.version, 1);
  assert.equal(artifact.goal.text, "ship feature");
  assert.match(artifact.resumePrompt, /Continue this goal/);
  const formatted = formatGoalHandoffArtifact(artifact);
  assert.match(formatted, /Goal handoff/);
});

test("buildGoalResumePrompt includes open todos", () => {
  const prompt = buildGoalResumePrompt(
    { text: "fix tests" },
    { openTodos: [{ id: "t1", text: "run npm test", status: "pending" }], changed: ["src/x.js"], stats: { steps: 3, toolCalls: 2 } }
  );
  assert.match(prompt, /fix tests/);
  assert.match(prompt, /run npm test/);
  assert.match(prompt, /src\/x\.js/);
});

test("buildCompactionContext returns empty string without todos or memory", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-"));
  assert.equal(buildCompactionContext(cwd), "");
});

test("resolveMcpTimeouts clamps probe retries", () => {
  const timeouts = resolveMcpTimeouts({ startupTimeoutMs: 5000, requestTimeoutMs: 10000, probeRetries: 99 });
  assert.equal(timeouts.startupTimeoutMs, 5000);
  assert.equal(timeouts.probeRetries, 5);
});

test("harnessCapabilities lists core harness features", () => {
  const caps = harnessCapabilities();
  assert.ok(caps.features.parallelSubagents);
  assert.ok(caps.features.goalHandoff);
  assert.ok(caps.modes.includes("goal"));
  assert.ok(caps.permissionProfiles.length >= 4);
});