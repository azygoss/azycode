import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HOOK_EVENTS, loadHookConfig, runHooks } from "../src/hooks.js";

test("loadHookConfig merges global, project, and inline hooks", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-hooks-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-hooks-repo-"));
  process.env.AZYCODE_HOME = home;
  fs.writeFileSync(path.join(home, "hooks.json"), JSON.stringify({
    pre_model: ["echo global"]
  }), "utf8");
  fs.mkdirSync(path.join(repo, ".azycode"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".azycode", "hooks.json"), JSON.stringify({
    pre_model: ["echo project"],
    post_tool: ["echo audit"]
  }), "utf8");

  const hooks = loadHookConfig({ hooks: { agent_run_end: ["echo inline"] } }, repo);
  assert.deepEqual(hooks.pre_model, ["echo global", "echo project"]);
  assert.deepEqual(hooks.post_tool, ["echo audit"]);
  assert.deepEqual(hooks.agent_run_end, ["echo inline"]);
  assert.equal(HOOK_EVENTS.includes("pre_tool"), true);
});

test("runHooks can modify payload and block execution", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-hooks-run-"));
  const modified = await runHooks("pre_model", { step: 1, model: "mock" }, {
    pre_model: [{ command: "echo", args: ['{"modify":{"step":42}}'] }]
  }, { cwd });
  assert.equal(modified.step, 42);
  assert.equal(modified.model, "mock");

  await assert.rejects(
    () => runHooks("pre_tool", { tool: "shell" }, {
      pre_tool: [{ command: "echo", args: ['{"block":true,"message":"blocked by policy"}'] }]
    }, { cwd }),
    /blocked by policy/
  );
});

test("runHooks post_model modify can attach skipTools filter", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-hooks-skip-"));
  const modified = await runHooks("post_model", { tools: ["write_file", "shell"] }, {
    post_model: [{ command: "echo", args: ['{"modify":{"skipTools":["write_file"]}}'] }]
  }, { cwd });
  assert.deepEqual(modified.skipTools, ["write_file"]);
  assert.deepEqual(modified.tools, ["write_file", "shell"]);
});

test("runHooks aborts long-running hook subprocesses when signal is triggered", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-hooks-abort-"));
  const controller = new AbortController();
  const sleep = process.platform === "win32" ? "timeout 5" : "sleep 5";
  const promise = runHooks("pre_model", { step: 1 }, {
    pre_model: [{ command: sleep, timeoutMs: 10_000 }]
  }, { cwd, signal: controller.signal });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(promise, /Aborted/i);
});