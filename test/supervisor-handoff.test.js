import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  aggregateSubagentResults,
  buildSupervisorBrief,
  formatSubagentResults,
  formatSupervisorSummary
} from "../src/subagents.js";
import {
  buildGoalHandoffArtifact,
  buildGoalResumePrompt,
  collectChangedFiles,
  formatGoalHandoffArtifact,
  parseGitStatusPaths
} from "../src/agent-report.js";
import { addBacklogItem } from "../src/backlog.js";
import { appendProgressEntry } from "../src/progress-log.js";
import { compactConversationDeterministic } from "../src/compaction.js";
import { addMemory } from "../src/memory.js";
import { defaultConfig } from "../src/config.js";
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

test("buildGoalHandoffArtifact captures todos backlog progress and resume prompt", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-handoff-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-handoff-"));
  process.env.AZYCODE_HOME = home;
  addBacklogItem(cwd, "add safety tests", { priority: "high", area: "safety" });
  appendProgressEntry(cwd, "path-guard hardened", { level: "milestone", goalId: "goal_1" });

  const artifact = buildGoalHandoffArtifact({
    goal: { id: "goal_1", text: "ship feature", status: "running", sessions: [] },
    cwd,
    events: [{ type: "tool_start", tool: "read_file", at: new Date().toISOString() }],
    sessionId: "ses_test"
  });
  assert.equal(artifact.version, 2);
  assert.equal(artifact.goal.text, "ship feature");
  assert.ok(artifact.backlog.active.length >= 1);
  assert.ok(artifact.progress.entries.length >= 1);
  assert.match(artifact.resumePrompt, /Continue this goal/);
  assert.match(artifact.resumePrompt, /safety tests/);
  const formatted = formatGoalHandoffArtifact(artifact);
  assert.match(formatted, /Goal handoff/);
  assert.match(formatted, /Backlog/);
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

test("buildCompactionContext returns empty string without todos backlog progress or memory", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-"));
  process.env.AZYCODE_HOME = home;
  assert.equal(buildCompactionContext(cwd), "");
});

test("buildCompactionContext includes backlog and progress state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-home-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-cwd-2-"));
  process.env.AZYCODE_HOME = home;
  addBacklogItem(cwd, "orchestration improvements", { area: "orchestration" });
  appendProgressEntry(cwd, "compaction enhanced", { level: "milestone" });
  const ctx = buildCompactionContext(cwd);
  assert.match(ctx, /Feature backlog/);
  assert.match(ctx, /Progress log/);
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
  assert.ok(caps.features.featureBacklog);
  assert.ok(caps.features.progressLog);
  assert.ok(caps.features.permissionClassifier);
  assert.ok(caps.modes.includes("goal"));
  assert.ok(caps.permissionProfiles.length >= 4);
});

test("aggregateSubagentResults includes nextSteps for failed runs", () => {
  const results = [
    { index: 1, agent: "explorer", ok: true, durationMs: 10, output: "ok", changedFiles: ["src/x.js"] },
    { index: 2, agent: "reviewer", ok: false, durationMs: 5, error: "timeout", changedFiles: [] }
  ];
  const aggregate = aggregateSubagentResults(results);
  assert.ok(aggregate.nextSteps.length >= 1);
  assert.match(aggregate.nextSteps.join(" "), /Retry failed/);
});

test("formatSubagentResults supervisor mode includes brief and full per-agent bodies", () => {
  const results = [
    { index: 1, agent: "explorer", ok: true, durationMs: 10, output: "full explorer body", changedFiles: [] },
    { index: 2, agent: "reviewer", ok: true, durationMs: 20, output: "full reviewer body", changedFiles: ["src/x.js"] }
  ];
  const text = formatSubagentResults(results, { supervisor: true });
  assert.match(text, /Supervisor summary/);
  assert.match(text, /full explorer body/);
  assert.match(text, /full reviewer body/);
  const json = JSON.parse(formatSubagentResults(results, { supervisor: true, json: true }));
  assert.equal(json.supervisor.total, 2);
  assert.equal(json.results.length, 2);
});

test("parseGitStatusPaths handles renames and modified paths", () => {
  assert.equal(parseGitStatusPaths(" M src/agent-report.js"), "src/agent-report.js");
  assert.equal(parseGitStatusPaths("R  old.js -> new.js"), "new.js");
  assert.equal(parseGitStatusPaths('?? "quoted.js"'), "quoted.js");
});

test("collectChangedFiles returns full paths from git status --short", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-git-status-"));
  execFileSync("git", ["init"], { cwd, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/test"], { cwd, stdio: "ignore" });
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "tracked.js"), "x\n");
  execFileSync("git", ["add", "src/tracked.js"], { cwd, stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "src", "tracked.js"), "changed\n");
  const files = collectChangedFiles(cwd);
  assert.ok(files.includes("src/tracked.js"));
});

test("compactConversationDeterministic scopes backlog to goalId when provided", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-goal-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-goal-cwd-"));
  process.env.AZYCODE_HOME = home;
  addBacklogItem(cwd, "goal-specific task", { goalId: "goal_a" });
  addBacklogItem(cwd, "other goal task", { goalId: "goal_b" });
  const messages = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `msg-${index}`
  }));
  const compacted = compactConversationDeterministic(messages, {
    keepRecent: 4,
    cwd,
    goalId: "goal_a"
  });
  assert.match(compacted[0].content, /goal-specific task/);
  assert.doesNotMatch(compacted[0].content, /other goal task/);
});

test("compactConversationDeterministic preserves memory when cwd is provided", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-compact-cwd-"));
  process.env.AZYCODE_HOME = home;
  addMemory("always run npm test after edits", ["testing"]);
  const messages = [];
  for (let index = 0; index < 20; index += 1) {
    messages.push({ role: "user", content: `msg-${index}` });
    messages.push({ role: "assistant", content: `ack-${index}` });
  }
  const compacted = compactConversationDeterministic(messages, {
    keepRecent: 4,
    cwd,
    prompt: "npm test after edits"
  });
  assert.match(compacted[0].content, /Relevant memory/);
  assert.match(compacted[0].content, /npm test/);
});

test("defaultConfig enables subagentSupervisor by default", () => {
  assert.equal(defaultConfig().subagentSupervisor, true);
});