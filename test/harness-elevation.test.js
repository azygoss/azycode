import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildGoalHandoffArtifact,
  buildGoalResumePrompt,
  upgradeGoalHandoffArtifact
} from "../src/agent-report.js";
import { addBacklogItem } from "../src/backlog.js";
import { appendProgressEntry } from "../src/progress-log.js";
import { buildCompactionContext } from "../src/compaction.js";
import { classifyToolRisk, suggestPermissionDecision } from "../src/permissions.js";
import { classifyShellCommand } from "../src/shell-risk.js";
import { normalizeWorkspacePath } from "../src/path-guard.js";
import { buildMcpServerEnv } from "../src/mcp.js";
import { defaultConfig } from "../src/config.js";

test("harness elevation pure units produce complete handoff artifact", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-cwd-"));
  process.env.AZYCODE_HOME = home;

  addBacklogItem(cwd, "harden shell-risk", { priority: "critical", area: "safety" });
  appendProgressEntry(cwd, "redirection tests added", { level: "milestone", goalId: "g1" });

  const artifact = buildGoalHandoffArtifact({
    goal: { id: "g1", text: "elevate harness", status: "running" },
    cwd,
    sessionId: "ses_elev"
  });

  assert.equal(artifact.version, 2);
  assert.ok(artifact.backlog.active.length >= 1);
  assert.ok(artifact.progress.entries.length >= 1);
  assert.match(artifact.resumePrompt, /harden shell-risk/);
  assert.match(artifact.resumePrompt, /redirection tests/);
  assert.ok(artifact.todos);
  assert.ok(artifact.changedFiles);
});

test("compaction context preserves backlog and progress across trim", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-home-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-cwd-2-"));
  process.env.AZYCODE_HOME = home;

  addBacklogItem(cwd, "orchestration DAG");
  appendProgressEntry(cwd, "subagent supervisor wired", { level: "info" });
  const ctx = buildCompactionContext(cwd, { goalId: "g1", prompt: "orchestration" });
  assert.match(ctx, /Feature backlog/);
  assert.match(ctx, /Progress log/);
});

test("safety classifiers reject escape paths and dangerous shell", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-path-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-out-"));
  fs.symlinkSync(outside, path.join(dir, "escape-link"));
  const norm = normalizeWorkspacePath(dir, "escape-link", { resolveSymlinks: true });
  assert.equal(norm.ok, false);

  const shell = classifyShellCommand("echo x > /etc/passwd");
  assert.equal(shell.level, "destructive");

  const env = buildMcpServerEnv({ name: "test", env: { LD_PRELOAD: "/evil.so", FOO: "bar" } });
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.FOO, "bar");
});

test("permission classifier reduces fatigue for safe reads", () => {
  const cfg = defaultConfig();
  const read = suggestPermissionDecision(cfg, "read_file", { file: "src/index.js" });
  assert.equal(read.fatigueReduction, true);
  assert.equal(read.decision, "auto");

  const sensitive = classifyToolRisk("write_file", { file: ".env" });
  assert.equal(sensitive.level, "high");
});

test("upgradeGoalHandoffArtifact upgrades persisted v1 handoffs to v2", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-home-3-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-elev-cwd-3-"));
  process.env.AZYCODE_HOME = home;
  addBacklogItem(cwd, "finish backlog CLI");

  const v1 = {
    version: 1,
    generatedAt: "2026-06-29T00:00:00.000Z",
    goal: { text: "old goal", status: "stalled" },
    sessionId: "ses_old",
    stats: { steps: 2, toolCalls: 1 },
    todos: { open: [], completed: [] },
    changedFiles: ["src/x.js"],
    resumePrompt: "Continue old goal"
  };
  const upgraded = upgradeGoalHandoffArtifact(v1, { goal: { id: "g_old", text: "old goal" }, cwd });
  assert.equal(upgraded.version, 2);
  assert.ok(upgraded.backlog);
  assert.ok(upgraded.progress);
  assert.equal(upgraded.stats.steps, 2);
});

test("buildGoalResumePrompt includes backlog progress and changed sections", () => {
  const prompt = buildGoalResumePrompt(
    { text: "ship v2" },
    {
      openTodos: [{ id: "t1", text: "run tests", status: "pending" }],
      backlog: { active: [{ id: "b1", text: "add backlog CLI", status: "pending", priority: "high", area: "persistence" }] },
      progress: { entries: [{ message: "tests green", level: "milestone", at: new Date().toISOString() }], blockers: [] },
      changed: ["src/backlog.js"],
      stats: { steps: 5, toolCalls: 3 }
    }
  );
  assert.match(prompt, /ship v2/);
  assert.match(prompt, /run tests/);
  assert.match(prompt, /add backlog CLI/);
  assert.match(prompt, /tests green/);
  assert.match(prompt, /src\/backlog\.js/);
});