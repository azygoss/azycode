import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitGuard, validateBranchName, formatGuardJson, resolveGitGuard } from "../src/guard.js";
import { defaultConfig } from "../src/config.js";

test("gitGuard blocks configured protected branch", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-guard-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: dir, stdio: "ignore" });
  const result = gitGuard(dir, { gitGuard: { enabled: true, blockBranches: ["main"], requireClean: false } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /blocked/);
});

test("gitGuard requireClean blocks dirty worktree", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-guard-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "x.txt"), "x\n");
  const result = gitGuard(dir, { gitGuard: { enabled: true, blockBranches: [], requireClean: true } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /not clean/);
});

test("validateBranchName accepts safe branch names", () => {
  assert.equal(validateBranchName("feature/foo-bar_123"), "feature/foo-bar_123");
  assert.equal(validateBranchName("main"), "main");
});

test("defaultConfig enables git guard by default", () => {
  const cfg = defaultConfig();
  assert.equal(cfg.gitGuard.enabled, true);
  assert.deepEqual(cfg.gitGuard.blockBranches, ["main", "master"]);
});

test("gitGuard allows writes on non-protected branch when enabled", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-guard-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/x"], { cwd: dir, stdio: "ignore" });
  const result = gitGuard(dir, defaultConfig());
  assert.equal(result.ok, true);
  assert.equal(result.branch, "feature/x");
});

test("gitGuard can be explicitly disabled via config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-guard-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: dir, stdio: "ignore" });
  const result = gitGuard(dir, { gitGuard: { enabled: false, blockBranches: ["main"] } });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
});

test("gitGuard warns on detached HEAD in non-git workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-guard-"));
  const result = gitGuard(dir, defaultConfig());
  assert.equal(result.ok, true);
  assert.ok((result.warnings || []).some((w) => /branch/i.test(w)));
});

test("formatGuardJson returns structured output", () => {
  const json = formatGuardJson({ ok: false, enabled: true, reason: "blocked", branch: "main", warnings: [] });
  assert.equal(json.ok, false);
  assert.equal(json.branch, "main");
});

test("resolveGitGuard treats undefined enabled as true", () => {
  const guard = resolveGitGuard({ gitGuard: {} });
  assert.equal(guard.enabled, true);
});

test("validateBranchName rejects unsafe characters", () => {
  assert.throws(() => validateBranchName("feat@scope"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat:thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat~thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("-leading-dash"), /Invalid branch name/);
  assert.throws(() => validateBranchName("dots..dots"), /Invalid branch name/);
  assert.throws(() => validateBranchName(""), /Invalid branch name/);
});
