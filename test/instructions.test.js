import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { clearInstructionCache, discoverProjectInstructions, listInstructionSources } from "../src/instructions.js";

function initGitRepo(dir) {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
}

test("discoverProjectInstructions merges AGENTS.md from root and nested dirs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-repo-"));
  process.env.AZYCODE_HOME = home;
  fs.writeFileSync(path.join(home, "AGENTS.md"), "Global rule: use pnpm.", "utf8");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Repo rule: run npm test.", "utf8");
  fs.mkdirSync(path.join(repo, "services", "api"), { recursive: true });
  fs.writeFileSync(path.join(repo, "services", "api", "AGENTS.override.md"), "API rule: keep handlers thin.", "utf8");
  initGitRepo(repo);
  clearInstructionCache();

  const text = discoverProjectInstructions(path.join(repo, "services", "api"));
  assert.match(text, /Global rule/);
  assert.match(text, /Repo rule/);
  assert.match(text, /API rule/);
  assert.equal(listInstructionSources(path.join(repo, "services", "api")).length, 3);
});

test("discoverProjectInstructions stops at git root and ignores parent dirs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-git-home-"));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "azy-git-parent-"));
  const repo = path.join(parent, "repo");
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(parent, "AGENTS.md"), "Parent rule: do not load.", "utf8");
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Repo rule: load me.", "utf8");
  initGitRepo(repo);
  clearInstructionCache();

  const text = discoverProjectInstructions(repo);
  assert.match(text, /Repo rule/);
  assert.doesNotMatch(text, /Parent rule/);
  const sources = listInstructionSources(repo);
  assert.equal(sources.some((source) => source.endsWith(`${path.sep}parent${path.sep}AGENTS.md`)), false);
});

test("discoverProjectInstructions caches until instruction files change", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cache-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cache-repo-"));
  process.env.AZYCODE_HOME = home;
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Version one.", "utf8");
  const first = discoverProjectInstructions(repo);
  assert.match(first, /Version one/);
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Version two.", "utf8");
  const second = discoverProjectInstructions(repo);
  assert.match(second, /Version two/);
  assert.doesNotMatch(second, /Version one/);
});