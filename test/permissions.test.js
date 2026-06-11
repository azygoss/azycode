import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPermissionProfile,
  resolveToolPermission,
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