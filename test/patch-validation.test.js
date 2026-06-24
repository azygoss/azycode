import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { formatPatchValidationReport, validatePatch } from "../src/patch-validation.js";

function initRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "base\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
}

const SAMPLE_PATCH = [
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "index 0000000..ce01324",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
  ""
].join("\n");

test("validatePatch applies patch in isolated worktree without mutating main workspace", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-patch-validate-"));
  initRepo(repo);
  const report = await validatePatch({ cwd: repo, patch: SAMPLE_PATCH, checks: [] });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "worktree");
  assert.ok(report.worktree);
  assert.deepEqual(report.changedFiles, ["new.txt"]);
  assert.equal(fs.existsSync(path.join(repo, "new.txt")), false);
  assert.match(formatPatchValidationReport(report), /ok: yes/);
});

test("validatePatch reports apply failures", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-patch-fail-"));
  initRepo(repo);
  const report = await validatePatch({
    cwd: repo,
    patch: "diff --git a/broken.txt b/broken.txt\n--- a/broken.txt\n+++ b/broken.txt\n@@ -1 +1 @@\n-old\n+new\n",
    checks: []
  });
  assert.equal(report.ok, false);
  assert.ok(report.error);
});

test("validatePatch runs configured checks in worktree", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-patch-check-"));
  initRepo(repo);
  const report = await validatePatch({
    cwd: repo,
    patch: SAMPLE_PATCH,
    checks: ["node -e \"process.exit(0)\""]
  });
  assert.equal(report.ok, true);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].ok, true);
});

test("validatePatch blocks patches targeting protected paths (.env)", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-patch-protected-"));
  initRepo(repo);
  const envPatch = [
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+SECRET=leaked",
    ""
  ].join("\n");
  const report = await validatePatch({ cwd: repo, patch: envPatch, checks: [] });
  assert.equal(report.ok, false);
  assert.match(report.error, /protected path|\.env/i);
});

test("validatePatch blocks dangerous shell checks by policy", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-patch-shell-"));
  initRepo(repo);
  const report = await validatePatch({
    cwd: repo,
    patch: SAMPLE_PATCH,
    checks: ["rm -rf /tmp/azy-dangerous-nonexistent"]
  });
  assert.equal(report.ok, false);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].ok, false);
  assert.match(report.checks[0].error || "", /destructive|policy|denied/i);
});