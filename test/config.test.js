import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

test("config saves and redacts independent home", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azycode-"));
  process.env.AZYCODE_HOME = dir;
  const mod = await import(`../src/config.js?x=${Date.now()}`);
  const cfg = mod.loadConfig();
  cfg.activeProvider = "byok";
  cfg.providers.byok = { apiKey: "sk-abcdefghijkl", baseUrl: "http://localhost:11434/v1", model: "local" };
  mod.saveConfig(cfg);
  const loaded = mod.loadConfig();
  assert.equal(loaded.activeProvider, "byok");
  assert.equal(loaded.providers.byok.model, "local");
  assert.equal(mod.maskSecret("sk-abcdefghijkl"), "sk-a...ijkl");
});

test("mode and reasoning rotation are stable", async () => {
  const mod = await import(`../src/config.js?y=${Date.now()}`);
  assert.equal(mod.rotateMode("plan"), "build");
  assert.equal(mod.rotateMode("build"), "always-approve");
  assert.equal(mod.rotateMode("review"), "plan");
  assert.equal(mod.DEFAULT_MODE, "build");
  assert.equal(mod.normalizeMode("approve"), "always-approve");
  assert.equal(mod.normalizeMode("normal"), "build");
  assert.equal(mod.rotateReasoning("minimal"), "low");
  assert.equal(mod.rotateReasoning("high"), "minimal");
});

test("loadConfig merges new default tool policies into old config files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azycode-"));
  process.env.AZYCODE_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    version: 1,
    toolPolicy: { shell: "deny" },
    subagents: { custom: { description: "x", system: "custom", reasoning: "low", model: null } }
  }));
  const mod = await import(`../src/config.js?z=${Date.now()}`);
  const cfg = mod.loadConfig();
  assert.equal(cfg.toolPolicy.shell, "deny");
  assert.equal(cfg.toolPolicy.apply_patch, "ask");
  assert.equal(cfg.toolPolicy.git_diff, "auto");
  assert.equal(cfg.toolPolicy.git_checkout, "auto");
  assert.equal(cfg.toolPolicy.read_many_files, "auto");
  assert.equal(cfg.toolPolicy.delete_path, "ask");
  assert(cfg.subagents.planner);
  assert.match(cfg.subagents.planner.system, /Do not modify files/);
  assert.match(cfg.subagents.reviewer.system, /Lead with actionable findings/);
  assert.match(cfg.subagents.implementer.system, /bounded read\/search/);
  assert.match(cfg.subagents.explorer.system, /read-only tools/);
  assert(cfg.subagents.custom);
  assert.equal(cfg.compaction, "trim");
  assert.equal(cfg.toolPolicy.spawn_subagents, "ask");
  assert.equal(cfg.toolPolicy.git_worktree, "ask");
});

test("resolveAgentMaxSteps is unlimited by default and optional when set", async () => {
  const mod = await import(`../src/config.js?s=${Date.now()}`);
  assert.equal(mod.resolveAgentMaxSteps({}), null);
  assert.equal(mod.resolveAgentMaxSteps({}, 40), 40);
  assert.equal(mod.resolveAgentMaxSteps({ agentMaxSteps: 30 }), 30);
  assert.equal(mod.resolveAgentMaxSteps({ agentMaxSteps: 0 }), null);
  assert.equal(mod.resolveAgentMaxSteps({}, "unlimited"), null);
  assert.equal(mod.formatAgentStepLimit(null), "unlimited steps");
  assert.equal(mod.formatAgentStepLimit(12), "max 12 steps");
});

test("defaultConfig enables git guard and path protections", async () => {
  const mod = await import(`../src/config.js?guard=${Date.now()}`);
  const cfg = mod.defaultConfig();
  assert.equal(cfg.gitGuard.enabled, true);
  assert.equal(cfg.pathGuard.allowEnv, false);
  assert.equal(cfg.shellPolicy.allowDestructive, false);
  assert.equal(cfg.sandbox.mode, "local");
});

test("saved gitGuard.enabled false is preserved on load", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azycode-"));
  process.env.AZYCODE_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    gitGuard: { enabled: false }
  }));
  const mod = await import(`../src/config.js?gd=${Date.now()}`);
  const cfg = mod.loadConfig();
  assert.equal(cfg.gitGuard.enabled, false);
});

test("permission profiles rewrite effective tool policy", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azycode-"));
  process.env.AZYCODE_HOME = dir;
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ permissionProfile: "read-only" }));
  const mod = await import(`../src/config.js?p=${Date.now()}`);
  const cfg = mod.loadConfig();
  assert.equal(cfg.toolPolicy.write_file, "deny");
  assert.equal(cfg.toolPolicy.shell, "deny");
});

test("validateConfig migrates legacy normal mode to build", async () => {
  const mod = await import(`../src/config.js?legacy=${Date.now()}`);
  const cfg = mod.defaultConfig();
  cfg.mode = "normal";
  mod.validateConfig(cfg);
  assert.equal(cfg.mode, "build");
});

test("validateConfig normalizes invalid mode and reasoning", async () => {
  const mod = await import(`../src/config.js?v=${Date.now()}`);
  const cfg = mod.defaultConfig();
  cfg.mode = "invalid-mode";
  cfg.reasoning = "extreme";
  cfg.permissionProfile = "unknown";
  cfg.toolPolicy = { shell: "block", unknown_tool: "auto" };
  mod.validateConfig(cfg);
  assert.equal(cfg.mode, "build");
  assert.equal(cfg.reasoning, "medium");
  assert.equal(cfg.permissionProfile, "normal");
  assert.equal(cfg.toolPolicy.shell, "ask");
  assert.equal(cfg.toolPolicy.unknown_tool, undefined);
});

test("config caching returns consistent values across calls", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azycode-"));
  process.env.AZYCODE_HOME = dir;
  const mod = await import(`../src/config.js?c=${Date.now()}`);
  const first = mod.loadConfig();
  const second = mod.loadConfig();
  assert.deepStrictEqual(first, second);
});
