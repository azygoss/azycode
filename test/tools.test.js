import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTools } from "../src/tools.js";
import { createModeRuntime } from "../src/agent-runtime.js";

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

test("read_file can return bounded line ranges", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "lines.txt"), "one\ntwo\nthree\nfour\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const readFile = tools.find((tool) => tool.name === "read_file");
  assert.equal(await readFile.run({ file: "lines.txt", startLine: 2, endLine: 3 }), "two\nthree");
  assert.equal(await readFile.run({ file: "lines.txt", startLine: 2, endLine: 2, showLineNumbers: true }), "   2 two");
});

test("search can limit noisy result sets", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "hits.txt"), "needle one\nneedle two\nneedle three\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const search = tools.find((tool) => tool.name === "search");
  const output = await search.run({ query: "needle", maxResults: 2 });
  assert.match(output, /needle one/);
  assert.match(output, /truncated/);
  assert.doesNotMatch(output, /needle three/);
});

test("built-in tools inspect read and manage workspace paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(dir, "b.txt"), "beta\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {}, gitGuard: { enabled: false } } });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  assert.match(await byName.read_many_files.run({ files: ["a.txt", "b.txt"] }), /--- a\.txt ---[\s\S]*alpha[\s\S]*--- b\.txt ---[\s\S]*beta/);
  assert.match(await byName.file_info.run({ path: "a.txt" }), /"type": "file"/);
  assert.match(await byName.git_status.run({}), /##/);

  assert.equal(await byName.make_dir.run({ dir: "nested" }), "created nested");
  assert.match(await byName.copy_path.run({ from: "a.txt", to: "nested/copy.txt" }), /copied a\.txt -> nested\/copy\.txt/);
  assert.match(await byName.move_path.run({ from: "nested/copy.txt", to: "nested/moved.txt" }), /moved nested\/copy\.txt -> nested\/moved\.txt/);
  assert.equal(await byName.delete_path.run({ path: "nested/moved.txt" }), "deleted nested/moved.txt");
  assert.equal(fs.existsSync(path.join(dir, "nested", "moved.txt")), false);
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
  const deletePath = tools.find((tool) => tool.name === "delete_path");
  await assert.rejects(() => deletePath.run({ path: "x.txt" }), /blocked/);
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

test("todo tool manages workspace todos", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-todo-home-"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-todo-"));
  process.env.AZYCODE_HOME = home;
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const todo = tools.find((tool) => tool.name === "todo");
  assert.match(await todo.run({ action: "add", text: "Ship feature" }), /added todo_/);
  assert.match(await todo.run({ action: "list" }), /Ship feature/);
});

test("set_mode tool switches runtime mode for the agent run", async () => {
  const runtime = createModeRuntime("always-approve");
  const tools = createTools({
    cwd: process.cwd(),
    cfg: { alwaysApprove: true, toolPolicy: {} },
    resolveCfg: () => ({ alwaysApprove: true, toolPolicy: {} }),
    modeRuntime: runtime
  });
  const setMode = tools.find((tool) => tool.name === "set_mode");
  assert.ok(setMode);
  assert.match(await setMode.run({ mode: "plan", reason: "plan first" }), /plan/);
  assert.equal(runtime.getMode(), "plan");
});
