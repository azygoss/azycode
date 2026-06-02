import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitGuard, validateBranchName } from "../src/guard.js";

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

test("validateBranchName rejects unsafe characters", () => {
  assert.throws(() => validateBranchName("feat@scope"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat:thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat~thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("feat thing"), /Invalid branch name/);
  assert.throws(() => validateBranchName("-leading-dash"), /Invalid branch name/);
  assert.throws(() => validateBranchName("dots..dots"), /Invalid branch name/);
  assert.throws(() => validateBranchName(""), /Invalid branch name/);
});
