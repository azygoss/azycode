import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { gitGuard } from "../src/guard.js";

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
