import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTools } from "../src/tools.js";
import { evaluateWritePath, isProtectedWritePath } from "../src/path-guard.js";
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