import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTools } from "../src/tools.js";
import { createModeRuntime } from "../src/agent-runtime.js";

test("apply_patch blocks patches targeting protected paths", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/patch"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({
    cwd: dir,
    cfg: { alwaysApprove: true, toolPolicy: {}, gitGuard: { enabled: true, blockBranches: ["main"] } }
  });
  const applyPatch = tools.find((tool) => tool.name === "apply_patch");
  const patch = [
    "diff --git a/.env b/.env",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/.env",
    "@@ -0,0 +1 @@",
    "+SECRET=bad",
    ""
  ].join("\n");
  await assert.rejects(() => applyPatch.run({ patch }), /protected path blocked/i);
});

test("write_file blocks symlink escaping the workspace (path traversal)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sym-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "azy-out-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "feature/sym"], { cwd: dir, stdio: "ignore" });
  // Plant a symlink inside the workspace that points outside of it.
  fs.symlinkSync(outside, path.join(dir, "escape-link"));
  const tools = createTools({
    cwd: dir,
    cfg: { alwaysApprove: true, toolPolicy: {}, gitGuard: { enabled: true, blockBranches: ["main"] } }
  });
  const writeFile = tools.find((t) => t.name === "write_file");
  await assert.rejects(
    () => writeFile.run({ file: "escape-link/owned.txt", content: "pwned\n" }),
    /escapes workspace|symlink/i
  );
  // Ensure nothing was written outside the workspace.
  assert.equal(fs.existsSync(path.join(outside, "owned.txt")), false);
});

test("apply_patch tool applies a unified diff inside workspace", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "hello.txt"), "old\n", "utf8");
  execFileSync("git", ["checkout", "-b", "feature/patch"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {}, gitGuard: { enabled: true, blockBranches: ["main"] } } });
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

test("read_file rejects binary files with metadata message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2, 0, 4]));
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const output = await tools.find((tool) => tool.name === "read_file").run({ file: "binary.bin" });
  assert.match(output, /Binary file/);
});

test("list_files caps huge directory listings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  for (let i = 0; i < 2100; i += 1) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const output = await tools.find((tool) => tool.name === "list_files").run({ dir: ".", depth: 1 });
  assert.match(output, /truncated at 2000 entries/);
});

test("read_many_files rejects binary files with metadata message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "binary.bin"), Buffer.from([0, 1, 2, 0, 4]));
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const output = await tools.find((tool) => tool.name === "read_many_files").run({ files: ["binary.bin"] });
  assert.match(output, /Binary file/);
});

test("shell tool aborts when signal is triggered", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {}, gitGuard: { enabled: false } } });
  const shell = tools.find((tool) => tool.name === "shell");
  const controller = new AbortController();
  const started = Date.now();
  const promise = shell.run(
    { command: process.platform === "win32" ? "timeout 30" : "sleep 30", timeoutMs: 60_000 },
    { signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(promise, /Aborted/i);
  assert.ok(Date.now() - started < 2000);
});

test("read_many_files tolerates missing files in a batch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "present.txt"), "ok\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const output = await tools.find((tool) => tool.name === "read_many_files").run({ files: ["present.txt", "missing.txt"] });
  assert.match(output, /present\.txt[\s\S]*ok/);
  assert.match(output, /missing\.txt[\s\S]*ERROR:/);
});

test("edit_file supports replaceAll", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  fs.writeFileSync(path.join(dir, "dup.txt"), "foo bar foo\n", "utf8");
  const tools = createTools({ cwd: dir, cfg: { alwaysApprove: true, toolPolicy: {} } });
  const result = await tools.find((tool) => tool.name === "edit_file").run({
    file: "dup.txt",
    search: "foo",
    replace: "baz",
    replaceAll: true
  });
  assert.match(result, /2 replacements/);
  assert.equal(fs.readFileSync(path.join(dir, "dup.txt"), "utf8"), "baz bar baz\n");
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

test("git_checkout escapes git guard on protected branch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-tools-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["checkout", "-b", "main"], { cwd: dir, stdio: "ignore" });
  const cfg = {
    alwaysApprove: true,
    toolPolicy: {},
    gitGuard: { enabled: true, blockBranches: ["main"], requireClean: false }
  };
  const tools = createTools({ cwd: dir, cfg });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const shell = byName.shell;
  await assert.rejects(() => shell.run({ command: "echo hi" }), /blocked/);

  const out = await byName.git_checkout.run({ branch: "feature/website", create: true });
  assert.match(out, /feature\/website/);
  assert.match(await byName.write_file.run({ file: "index.html", content: "<html></html>" }), /index\.html/);
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

test("git_worktree tool can add and list isolated worktrees", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-worktree-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "test"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  const tools = createTools({
    cwd: dir,
    cfg: { alwaysApprove: true, gitGuard: { enabled: false }, toolPolicy: {} }
  });
  const gitWorktree = tools.find((tool) => tool.name === "git_worktree");
  assert.ok(gitWorktree);
  await gitWorktree.run({ action: "add", name: "feat-a", branch: "feat/a", createBranch: true });
  const listed = await gitWorktree.run({ action: "list" });
  assert.match(listed, /feat\/a|\.azycode\/worktrees\/feat-a/i);
  const worktreePath = path.join(dir, ".azycode", "worktrees", "feat-a");
  assert.ok(fs.existsSync(worktreePath));
});

test("fatigueReduction emits approval_auto for profile-default low-risk reads", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-fatigue-"));
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "export const x = 1;\n");
  const events = [];
  let confirmCalled = false;
  const tools = createTools({
    cwd: dir,
    cfg: {
      alwaysApprove: false,
      permissionProfile: "normal",
      toolPolicy: {},
      gitGuard: { enabled: false }
    },
    confirmTool: async () => { confirmCalled = true; return false; },
    onApproval: (event) => events.push(event)
  });
  const readFile = tools.find((tool) => tool.name === "read_file");
  const result = await readFile.run({ file: "src/index.js" });
  assert.match(result, /export const x/);
  assert.equal(confirmCalled, false);
  assert.ok(events.some((e) => e.type === "approval_auto" && e.hint));
});
