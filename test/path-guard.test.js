import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTools } from "../src/tools.js";
import { evaluateWritePath, normalizeWorkspacePath, extractUnifiedDiffPaths, isProtectedWritePath } from "../src/path-guard.js";
import { defaultConfig } from "../src/config.js";

test("isProtectedWritePath blocks sensitive paths", () => {
  assert.equal(isProtectedWritePath(".env").protected, true);
  assert.equal(isProtectedWritePath(".git/config").protected, true);
  assert.equal(isProtectedWritePath("node_modules/pkg/index.js").protected, true);
  assert.equal(isProtectedWritePath("package-lock.json").protected, true);
  assert.equal(isProtectedWritePath(".github/workflows/ci.yml").protected, true);
  assert.equal(isProtectedWritePath("src/index.js").protected, false);
});

test("evaluateWritePath rejects workspace escape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-path-"));
  const result = evaluateWritePath(dir, "../outside", defaultConfig());
  assert.equal(result.allowed, false);
});

test("write_file blocks protected .env path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-path-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/test"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({
    cwd: dir,
    cfg: {
      alwaysApprove: true,
      gitGuard: { enabled: true, blockBranches: ["main"] },
      toolPolicy: {}
    }
  });
  const writeFile = tools.find((t) => t.name === "write_file");
  await assert.rejects(
    () => writeFile.run({ file: ".env", content: "SECRET=1\n" }),
    /protected path blocked/i
  );
});

test("extractUnifiedDiffPaths collects b/ destinations from patch", () => {
  const patch = [
    "diff --git a/.env b/.env",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+SECRET=1"
  ].join("\n");
  assert.deepEqual(extractUnifiedDiffPaths(patch), [".env"]);
});

test("write_file works on non-protected path on feature branch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-path-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/test"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({
    cwd: dir,
    cfg: {
      alwaysApprove: true,
      gitGuard: { enabled: true, blockBranches: ["main"] },
      toolPolicy: {}
    }
  });
  const writeFile = tools.find((t) => t.name === "write_file");
  const result = await writeFile.run({ file: "src/new.js", content: "export const x = 1;\n" });
  assert.match(result, /src\/new\.js/);
});

test("normalizeWorkspacePath rejects symlink escaping workspace", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "azy-outside-"));
  // Create a symlink inside the workspace pointing outside of it
  fs.symlinkSync(outside, path.join(dir, "escape-link"));
  const result = normalizeWorkspacePath(dir, "escape-link", { resolveSymlinks: true });
  assert.equal(result.ok, false, "symlink escaping workspace must be rejected");
  assert.match(result.reason, /escapes workspace|symlink/i);
});

test("normalizeWorkspacePath resolves symlinks only when requested", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-symlink2-"));
  fs.mkdirSync(path.join(dir, "real"));
  // Internal symlink pointing inside the workspace
  fs.symlinkSync(path.join(dir, "real"), path.join(dir, "link"));
  const plain = normalizeWorkspacePath(dir, "link");
  assert.equal(plain.ok, true, "symlink path is lexically inside workspace without resolution");
  const resolved = normalizeWorkspacePath(dir, "link", { resolveSymlinks: true });
  assert.equal(resolved.ok, true, "internal symlink should resolve inside workspace");
});

test("isProtectedWritePath blocks .git prefix and nested config", () => {
  assert.equal(isProtectedWritePath(".git/config").protected, true);
  assert.equal(isProtectedWritePath(".gitignore").protected, false, ".gitignore must not match .git pattern");
  assert.equal(isProtectedWritePath(".github/anything").protected, false, "plain .github dir is not CI workflow");
});

test("evaluateWritePath rejects backslash-traversal on posix", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-trav-"));
  const result = evaluateWritePath(dir, "..\\..\\etc\\passwd", defaultConfig());
  assert.equal(result.allowed, false);
});