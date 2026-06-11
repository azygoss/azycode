import test from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand, evaluateShellPolicy } from "../src/shell-risk.js";
import { defaultConfig } from "../src/config.js";
import { applyPermissionProfile as applyProfile } from "../src/permissions.js";

test("classifyShellCommand detects safe-read commands", () => {
  assert.equal(classifyShellCommand("git status").level, "safe-read");
  assert.equal(classifyShellCommand("pwd").level, "safe-read");
});

test("classifyShellCommand detects destructive commands", () => {
  assert.equal(classifyShellCommand("rm -rf node_modules").level, "destructive");
  assert.equal(classifyShellCommand("git reset --hard").level, "destructive");
});

test("classifyShellCommand detects network commands", () => {
  assert.equal(classifyShellCommand("curl https://example.com").level, "network");
  assert.equal(classifyShellCommand("npm install lodash").level, "network");
});

test("classifyShellCommand detects secret-risk commands", () => {
  assert.equal(classifyShellCommand("printenv").level, "secret-risk");
  assert.equal(classifyShellCommand("cat .env").level, "secret-risk");
});

test("evaluateShellPolicy denies destructive commands by default", () => {
  const cfg = defaultConfig();
  const result = evaluateShellPolicy("rm -rf /tmp/x", cfg);
  assert.equal(result.decision, "deny");
});

test("evaluateShellPolicy auto-approves safe-read in normal profile", () => {
  const cfg = defaultConfig();
  cfg.toolPolicy.shell = "ask";
  const result = evaluateShellPolicy("git diff", cfg);
  assert.equal(result.decision, "auto");
});

test("evaluateShellPolicy always asks for secret-risk", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "full-auto";
  cfg.toolPolicy.shell = "auto";
  const result = evaluateShellPolicy("printenv", cfg);
  assert.equal(result.decision, "ask");
});

test("trusted-workspace asks for network shell despite shell auto", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "trusted-workspace";
  applyProfile(cfg);
  assert.equal(cfg.toolPolicy.shell, "auto");
  const result = evaluateShellPolicy("curl https://example.com", cfg);
  assert.equal(result.decision, "ask");
});

test("full-auto still auto-approves network shell", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "full-auto";
  applyProfile(cfg);
  const result = evaluateShellPolicy("curl https://example.com", cfg);
  assert.equal(result.decision, "auto");
});

test("destructive allowed only with explicit config in full-auto", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "full-auto";
  cfg.shellPolicy.allowDestructive = true;
  const result = evaluateShellPolicy("rm -rf /tmp/safe", cfg);
  assert.equal(result.decision, "auto");
});