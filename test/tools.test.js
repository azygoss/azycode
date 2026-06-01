import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTools } from "../src/tools.js";

test("apply_patch tool applies a unified diff inside workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "hello.txt"), "old\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const applyPatch = tools.find((tool) => tool.name === "apply_patch");
  const patch = [
    "diff --git a/hello.txt b/hello.txt",
    "index 3367afd..3e75765 100644",
    "--- a/hello.txt",
    "+++ b/hello.txt",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    ""
  ].join("\n");
  const result = await applyPatch.run({ patch });
  assert.equal(result, "patch applied");
  assert.equal(fs.readFileSync(path.join(dir, "hello.txt"), "utf8"), "new\n");
});

test("tools reject paths that escape workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const readFile = tools.find((tool) => tool.name === "read_file");
  await assert.rejects(() => readFile.run({ file: "../outside" }), /Path escapes workspace/);
});

test("alwaysApprove does not bypass git guard", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({
    cwd: dir,
    cfg: {
      alwaysApprove: true,
      toolPolicy: {},
      gitGuard: { enabled: true, blockBranches: ["main"], requireClean: false }
    }
  });
  const writeFile = tools.find((tool) => tool.name === "write_file");
  await assert.rejects(() => writeFile.run({ file: "x.txt", content: "x" }), /blocked/);
});

test("ask policy can use a TUI confirmation callback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  const questions = [];
  const tools = createTools({
    cwd: dir,
    cfg: { alwaysApprove: false, toolPolicy: { read_file: "ask" } },
    confirmTool: async (question) => {
      questions.push(question);
      return true;
    }
  });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n", "utf8");
  const readFile = tools.find((tool) => tool.name === "read_file");
  assert.equal(await readFile.run({ file: "hello.txt" }), "hello\n");
  assert.match(questions[0], /Approve tool read_file/);
});
