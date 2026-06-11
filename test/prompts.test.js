import test from "node:test";
import assert from "node:assert/strict";
import { compactionSystemPrompt, defaultSubagents, systemForMode } from "../src/prompts.js";

test("systemForMode includes core workflow and mode-specific guidance", () => {
  const plan = systemForMode("plan", { cwd: "/tmp/repo" });
  assert.match(plan, /Workspace root:.*\/tmp\/repo/);
  assert.match(plan, /bounded tools deliberately/);
  assert.match(plan, /todo tool/);
  assert.match(plan, /set_mode/);
  assert.match(plan, /Do not modify files/);
  assert.match(plan, /verification commands/);

  const build = systemForMode("build");
  assert.match(build, /Build mode/);
  assert.match(build, /standard tool policy/);
  assert.match(build, /approval when policy is ask/);

  const goal = systemForMode("goal");
  assert.match(goal, /persist across steps/);
  assert.match(goal, /genuinely complete/);

  const review = systemForMode("review");
  assert.match(review, /strict code reviewer/);
  assert.match(review, /security risks/);
  assert.match(review, /ordered by severity/);
});

test("systemForMode includes step budget guidance when limited", () => {
  const limited = systemForMode("plan", { stepLimit: 12 });
  assert.match(limited, /at most 12 model steps/);
  assert.match(limited, /bonus turns/);

  const unlimited = systemForMode("plan");
  assert.match(unlimited, /No step cap/);
});

test("defaultSubagents ship focused role prompts", () => {
  const agents = defaultSubagents();
  assert.match(agents.planner.system, /Do not modify files/);
  assert.match(agents.planner.system, /verification commands/);
  assert.match(agents.reviewer.system, /Lead with actionable findings/);
  assert.match(agents.reviewer.system, /ordered by severity/);
  assert.match(agents.implementer.system, /bounded read\/search/);
  assert.match(agents.implementer.system, /verification results/);
  assert.match(agents.explorer.system, /read-only tools/);
  assert.match(agents.explorer.system, /open questions/);
});

test("compactionSystemPrompt preserves actionable session state", () => {
  const prompt = compactionSystemPrompt();
  assert.match(prompt, /file paths touched/);
  assert.match(prompt, /unfinished tasks/);
  assert.match(prompt, /plain-text summary only/);
});