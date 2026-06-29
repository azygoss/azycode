import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPermissionProfile,
  classifyToolRisk,
  resolveToolPermission,
  suggestPermissionDecision,
  toolCategory,
  PERMISSION_PROFILES,
  describePermissionProfile
} from "../src/permissions.js";
import { defaultConfig } from "../src/config.js";

test("permission profiles are registered", () => {
  assert(PERMISSION_PROFILES.includes("plan-only"));
  assert(PERMISSION_PROFILES.includes("trusted-workspace"));
});

test("toolCategory maps tools to categories", () => {
  assert.equal(toolCategory("read_file"), "read");
  assert.equal(toolCategory("write_file"), "write");
  assert.equal(toolCategory("shell"), "shell");
  assert.equal(toolCategory("web_fetch"), "network");
  assert.equal(toolCategory("spawn_subagents"), "subagent");
});

test("read-only profile denies writes and shell", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "read-only";
  applyPermissionProfile(cfg);
  assert.equal(cfg.toolPolicy.write_file, "deny");
  assert.equal(cfg.toolPolicy.shell, "deny");
  const perm = resolveToolPermission(cfg, "write_file");
  assert.equal(perm.allowed, false);
});

test("trusted-workspace auto-approves writes", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "trusted-workspace";
  applyPermissionProfile(cfg);
  const perm = resolveToolPermission(cfg, "write_file");
  assert.equal(perm.allowed, true);
});

test("plan-only matches read-only restrictions", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "plan-only";
  applyPermissionProfile(cfg);
  assert.equal(cfg.toolPolicy.edit_file, "deny");
  assert.equal(cfg.toolPolicy.web_fetch, "deny");
});

test("describePermissionProfile returns actionable text", () => {
  const info = describePermissionProfile("full-auto");
  assert.match(info.description, /Auto-approve/);
});

test("classifyToolRisk elevates sensitive file writes", () => {
  const risk = classifyToolRisk("write_file", { file: ".env" });
  assert.equal(risk.level, "high");
  assert.equal(risk.category, "write");
});

test("classifyToolRisk marks read tools as low risk", () => {
  const risk = classifyToolRisk("read_file", { file: "src/index.js" });
  assert.equal(risk.level, "low");
});

test("classifyToolRisk elevates destructive shell patterns", () => {
  const risk = classifyToolRisk("shell", { command: "rm -rf /tmp/x" });
  assert.equal(risk.level, "high");
});

test("suggestPermissionDecision reduces fatigue for low-risk reads with profile auto", () => {
  const cfg = defaultConfig();
  const suggestion = suggestPermissionDecision(cfg, "read_file", { file: "src/x.js" });
  assert.equal(suggestion.decision, "auto");
  assert.equal(suggestion.allowed, true);
  assert.equal(suggestion.classification.level, "low");
  assert.equal(suggestion.fatigueReduction, true);
  assert.match(suggestion.hint, /auto-approved/);
});

test("suggestPermissionDecision respects explicit ask override on low-risk reads", () => {
  const cfg = defaultConfig();
  cfg.toolPolicy.read_file = "ask";
  const suggestion = suggestPermissionDecision(cfg, "read_file", { file: "src/x.js" });
  assert.equal(suggestion.decision, "ask");
  assert.equal(suggestion.allowed, null);
  assert.equal(suggestion.fatigueReduction, false);
});

test("suggestPermissionDecision never bypasses deny rules", () => {
  const cfg = defaultConfig();
  cfg.permissionProfile = "read-only";
  applyPermissionProfile(cfg);
  const suggestion = suggestPermissionDecision(cfg, "write_file", { file: "src/x.js" });
  assert.equal(suggestion.allowed, false);
  assert.equal(suggestion.decision, "deny");
});

test("suggestPermissionDecision forwards sessionApproval to resolveToolPermission", () => {
  const cfg = defaultConfig();
  cfg.toolPolicy.write_file = "ask";
  const suggestion = suggestPermissionDecision(cfg, "write_file", {
    file: "src/x.js",
    sessionApproval: true
  });
  assert.equal(suggestion.allowed, true);
  assert.equal(suggestion.decision, "ask");
});