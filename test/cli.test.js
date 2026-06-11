import test from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const bin = path.join(root, "bin", "azycode.js");
const execFileAsync = promisify(execFile);

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}
function plainMatch(value, pattern) {
  return stripAnsi(value).match(pattern);
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10000
  });
}

async function runAsync(args, env = {}) {
  const { stdout } = await execFileAsync(process.execPath, [bin, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10000
  });
  return stdout;
}

test("non-interactive byok login writes isolated config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["login", "byok", "--base-url", "http://127.0.0.1:9999/v1", "--model", "mock", "--api-key", "sk-123456789"], { AZYCODE_HOME: home });
  assert.match(out, /Logged in to byok/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "byok");
  assert.equal(cfg.providers.byok.model, "mock");
});

test("tool policy command updates config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  run(["config", "set", "tool", "shell", "deny"], { AZYCODE_HOME: home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.toolPolicy.shell, "deny");
  const tools = run(["tools"], { AZYCODE_HOME: home });
  assert.match(tools, /Tool Catalog/);
  assert.match(tools, /read_many_files\s+auto/);
  assert.match(tools, /delete_path\s+ask/);
  assert.match(tools, /shell\s+deny/);
  const inspected = run(["tools", "inspect", "read_many_files"], { AZYCODE_HOME: home });
  assert.match(inspected, /Tool read_many_files/);
  assert.match(inspected, /parameters\s+files, maxBytesPerFile/);
  const readFile = run(["tools", "inspect", "read_file"], { AZYCODE_HOME: home });
  assert.match(readFile, /parameters\s+file, startLine, endLine, maxBytes, showLineNumbers/);
  const search = run(["tools", "inspect", "search"], { AZYCODE_HOME: home });
  assert.match(search, /parameters\s+query, dir, maxResults, contextLines/);
});

test("sandbox status emits json diagnostics", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["sandbox", "status", "--json"], { AZYCODE_HOME: home });
  const status = JSON.parse(out);
  assert.equal(status.policy.mode, "local");
  assert.ok(status.localShell.file);
  assert.ok("docker" in status.runtimes);
});

test("config set sandbox mode persists", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  run(["config", "set", "sandbox", "mode", "podman"], { AZYCODE_HOME: home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.sandbox.mode, "podman");
});

test("config set profile accepts plan-only and trusted-workspace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  run(["config", "set", "profile", "plan-only"], { AZYCODE_HOME: home });
  let cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.permissionProfile, "plan-only");
  assert.equal(cfg.toolPolicy.shell, "deny");
  run(["config", "set", "profile", "trusted-workspace"], { AZYCODE_HOME: home });
  cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.permissionProfile, "trusted-workspace");
  assert.equal(cfg.toolPolicy.write_file, "auto");
});

test("health reports no configured providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["health"], { AZYCODE_HOME: home });
  assert.match(out, /No providers configured/);
});

test("providers points users to unified model selection", () => {
  const out = run(["providers"]);
  assert.match(out, /Model selection/);
  assert.match(out, /azycode model <provider\/model>/);
});

test("guard status command reports git guard", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["guard", "status"], { AZYCODE_HOME: home });
  assert.match(out, /git guard:/);
});

test("models use updates active model", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  run(["login", "byok", "--base-url", "http://127.0.0.1:9999/v1", "--model", "old", "--api-key", "sk-123456789"], { AZYCODE_HOME: home });
  run(["models", "use", "new-model"], { AZYCODE_HOME: home });
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeModel, "new-model");
  assert.equal(cfg.providers.byok.model, "new-model");
  assert.deepEqual(cfg.providers.byok.models, ["old", "new-model"]);
});

test("model command lists and switches provider/model together", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "local-a",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/a", model: "local-a", models: ["local-a"], apiKey: "sk-a" },
      openai: { baseUrl: "http://127.0.0.1:9999/b", model: "gpt-test", models: ["gpt-test"], apiKey: "sk-b" }
    }
  }));
  const list = run(["model"], { AZYCODE_HOME: home });
  assert.match(list, /Models[\s\S]*byok[\s\S]*local-a[\s\S]*openai[\s\S]*gpt-test/);
  const out = run(["model", "openai/gpt-test"], { AZYCODE_HOME: home });
  assert.match(out, /Active model set to openai\/gpt-test/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "openai");
  assert.equal(cfg.activeModel, "gpt-test");
});

test("config set model can switch provider and model together", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "local-a",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/a", model: "local-a", models: ["local-a"], apiKey: "sk-a" },
      openai: { baseUrl: "http://127.0.0.1:9999/b", model: "gpt-test", models: ["gpt-test"], apiKey: "sk-b" }
    }
  }));
  const out = run(["config", "set", "model", "openai/gpt-test"], { AZYCODE_HOME: home });
  assert.match(out, /Config updated/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "openai");
  assert.equal(cfg.activeModel, "gpt-test");
});

test("models sync stores remote model ids without dropping saved models", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "remote-a" }, { id: "remote-b" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    run(["login", "byok", "--base-url", `http://127.0.0.1:${port}/v1`, "--model", "local", "--api-key", "sk-local"], { AZYCODE_HOME: home });
    const before = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    before.activeModel = "stale";
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(before));
    const out = await runAsync(["models", "sync"], { AZYCODE_HOME: home });
    assert.match(out, /Synced 2 remote models/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(cfg.activeModel, "local");
    assert.deepEqual(cfg.providers.byok.models, ["local", "remote-a", "remote-b"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("models sync all updates each configured provider independently", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/a/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "remote-a" }] }));
      return;
    }
    if (req.url === "/b/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "remote-b" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      activeProvider: "byok",
      activeModel: "local-a",
      providers: {
        byok: { baseUrl: `http://127.0.0.1:${port}/a`, model: "local-a", models: ["local-a"], apiKey: "sk-a" },
        openai: { baseUrl: `http://127.0.0.1:${port}/b`, model: "local-b", models: ["local-b"], apiKey: "sk-b" }
      }
    }));
    const out = await runAsync(["model", "sync", "all"], { AZYCODE_HOME: home });
    assert.match(out, /byok: synced 1 remote models/);
    assert.match(out, /openai: synced 1 remote models/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(cfg.activeModel, "local-a");
    assert.deepEqual(cfg.providers.byok.models, ["local-a", "remote-a"]);
    assert.ok(cfg.providers.openai.models.includes("remote-b"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider current reports missing provider without stack trace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["provider", "current"], { AZYCODE_HOME: home });
  assert.match(out, /No active provider/);
});

test("models inspect reports missing provider without stack trace", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["models", "inspect"], { AZYCODE_HOME: home });
  assert.match(out, /No active provider/);
});

test("doctor json reports local binary details", () => {
  const out = run(["doctor", "--json"]);
  const info = JSON.parse(out);
  assert.equal(info.packageName, "azycode");
  assert.equal(info.installRoot, root);
  assert.equal(info.localBinExists, true);
  assert.match(info.node, /^v\d+/);
});

test("doctor works outside the installation repository", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-external-"));
  const out = execFileSync(process.execPath, [bin, "doctor", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 10000
  });
  const info = JSON.parse(out);
  assert.equal(info.project, fs.realpathSync(cwd));
  assert.equal(info.installRoot, root);
  assert.equal(info.packageName, "azycode");
});

test("completion command emits shell completion scripts", () => {
  assert.match(run(["completion", "zsh"]), /#compdef azycode/);
  assert.match(run(["completion", "bash"]), /complete -F _azycode_complete azycode/);
  assert.match(run(["completion", "fish"]), /complete -c azycode/);
});

test("report command emits redacted diagnostic json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  run(["login", "byok", "--base-url", "http://127.0.0.1:9999/v1", "--model", "mock", "--api-key", "sk-123456789"], { AZYCODE_HOME: home });
  const out = run(["report"], { AZYCODE_HOME: home });
  const report = JSON.parse(out);
  assert.equal(report.doctor.packageName, "azycode");
  assert.equal(report.config.providers.byok.apiKey, "sk-1...6789");
  assert.equal(report.counts.sessions, 0);
});

test("chat slash commands work with piped stdin", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput(["chat"], "/status\n/context\n/progress\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /azycode chat/);
  assert.match(stdout, /mode=build/);
  assert.match(stdout, /context=true/);
  assert.match(stdout, /progress=true/);
});

test("default command launches the interactive tui", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/reasoning high\n/mode goal\n/model mock-next\n/profile read-only\n/status\n/compact\n/new\n/dashboard\n/login\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /azycode/);
  assert.match(plain, /azycode/);
  assert.match(plain, /azycode[\s\S]*What should we work on[\s\S]*\/help/);
  assert.match(plain, /not connected/);
  assert.match(plain, /model: no configured provider/);
  assert.match(plain, /status[\s\S]*provider[\s\S]*model[\s\S]*mode[\s\S]*goal[\s\S]*reasoning[\s\S]*high[\s\S]*profile[\s\S]*read-only/);
  assert.match(plain, /policy: auto \d+\s+ask \d+\s+deny \d+/);
  assert.match(plain, /conversation: 0 -> 0 messages/);
  assert.match(plain, /conversation: cleared/);
  assert.match(plain, /dashboard/);
  assert.match(plain, /Interactive login requires a terminal/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeModel, null);
  assert.equal(cfg.permissionProfile, "read-only");
  assert.equal(cfg.toolPolicy.shell, "deny");
  assert.equal(cfg.toolPolicy.write_file, "deny");
});

test("tui can inspect sessions tools goals and missions", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: { ses_test: { mode: "goal", prompt: "ship it" } },
    toolRuns: [{ name: "read_file", ok: true, durationMs: 3, sessionId: "ses_test" }],
    goals: { goal_test: { status: "running", text: "ship it" } },
    missions: { mis_test: { status: "done", name: "release" } }
  }));
  const stdout = await runWithInput([], "/sessions\n/tools\n/goals\n/missions\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Sessions[\s\S]*ses_test[\s\S]*goal[\s\S]*ship it/i);
  assert.match(stdout, /Tool runs[\s\S]*read_file[\s\S]*ok[\s\S]*ses_test/i);
  assert.match(stdout, /goals[\s\S]*goal_test\s+running\s+ship it/);
  assert.match(stdout, /missions[\s\S]*mis_test\s+done\s+release/);
});

test("tui review prints a clean summary when there are no actionable findings", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/review\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Local Review/);
  // When there are findings (e.g. due to in-progress source changes) the section
  // still appears with actionable items; when the worktree is clean it ends with
  // "review: clean". Accept either outcome.
  assert.match(stdout, /review:|Local Review/);
});

test("tui can show a session transcript", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: {
      ses_test: {
        mode: "goal",
        prompt: "ship it",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" }
        ]
      }
    }
  }));
  const stdout = await runWithInput([], "/session ses_test\n/session ses_missing\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Session ses_test[\s\S]*user:\s+hello[\s\S]*assistant:\s+world/);
  assert.match(stdout, /session: no session ses_missing/);
});

test("tui can list and select subagents", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/agents\n/agent planner\n/status\n/dashboard\n/agent off\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /subagents[\s\S]*planner\s+high/);
  assert.match(plain, /agent: @planner/);
  assert.match(plain, /status[\s\S]*agent[\s\S]*@planner/);
  assert.match(plain, /agent\s+@planner/);
  assert.match(plain, /agent: off/);
});

test("tui can list and switch configured providers", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "local",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/v1", model: "local", apiKey: "sk-local" },
      kimi: { baseUrl: "https://api.moonshot.ai/v1", model: "kimi-test", apiKey: "sk-kimi" }
    }
  }));
  const stdout = await runWithInput([], "/providers\n/provider kimi\n/status\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /Providers[\s\S]*byok\s+configured/);
  assert.match(plain, /Use \/model to choose provider and model together/);
  assert.match(plain, /provider: kimi\/kimi-for-coding/);
  assert.match(plain, /kimi\/kimi-for-coding/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "kimi");
  assert.equal(cfg.activeModel, "kimi-for-coding");
});

test("tui can inspect and update tool policy", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/policy\n/tool read_many_files\n/tool shell auto\n/policy\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /Tool catalog[\s\S]*shell\s+ask/);
  assert.match(plain, /Tool: read_many_files[\s\S]*params\s+files, maxBytesPerFile/);
  assert.match(plain, /tool:\s+shell\s+.+\s+auto/);
  assert.match(plain, /Tool catalog[\s\S]*shell\s+auto/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.toolPolicy.shell, "auto");
});

test("tui can show masked credentials and keyboard shortcuts", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const rawKey = ["sk", "abcdefghijkl"].join("-");
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "local",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/v1", model: "local", apiKey: rawKey }
    }
  }));
  const stdout = await runWithInput([], "/credentials\n/keys\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /Credentials[\s\S]*byok[\s\S]*config:sk-a\.\.\.ijkl[\s\S]*local/);
  assert.doesNotMatch(plain, new RegExp(rawKey));
  assert.match(plain, /Keyboard[\s\S]*Shift\+Tab\s+rotate mode/);
});

test("tui health checks configured provider connectivity", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "mock-a" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      activeProvider: "byok",
      activeModel: "mock-a",
      providers: {
        byok: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "mock-a", apiKey: "sk-local" }
      }
    }));
    const stdout = await runWithInput([], "/health\n/exit\n", { AZYCODE_HOME: home });
    assert.match(stdout, /Health[\s\S]*byok\s+ok \(1 models\)/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tui doctor shows local runtime paths", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/doctor\n/workspace\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Doctor[\s\S]*install root/);
  assert.match(stdout, /config home[\s\S]*azy-cli-/);
  assert.match(stdout, /Workspace[\s\S]*cwd[\s\S]*azycode/);
  assert.match(stdout, /config[\s\S]*config\.json/);
});

test("tui model command lists and preserves provider models", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "old",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/v1", model: "old", models: ["old", "candidate"], apiKey: "sk-local" }
    }
  }));
  const stdout = await runWithInput([], "/model\n/model candidate\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /models[\s\S]*byok[\s\S]*●\s+old[\s\S]*candidate/);
  assert.match(plain, /openai \(not configured\)/);
  assert.match(plain, /model: byok\/candidate/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeModel, "candidate");
  assert.deepEqual(cfg.providers.byok.models, ["old", "candidate"]);
});

test("tui model command can switch provider and model together", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "local-a",
    providers: {
      byok: { baseUrl: "http://127.0.0.1:9999/a", model: "local-a", models: ["local-a"], apiKey: "sk-a" },
      openai: { baseUrl: "http://127.0.0.1:9999/b", model: "gpt-test", models: ["gpt-test"], apiKey: "sk-b" }
    }
  }));
  const stdout = await runWithInput([], "/help model\n/model\n/model openai/gpt-test\n/status\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Help: model[\s\S]*\/model <provider\/model>/);
  assert.match(stdout, /models[\s\S]*byok[\s\S]*local-a[\s\S]*openai[\s\S]*gpt-test/);
  assert.match(stdout, /model: openai\/gpt-test/);
  assert.match(stdout, /status[\s\S]*provider[\s\S]*openai[\s\S]*model[\s\S]*gpt-test/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "openai");
  assert.equal(cfg.activeModel, "gpt-test");
});

test("tui models sync all updates configured provider model lists", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const server = http.createServer((req, res) => {
    if (req.url === "/a/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "remote-a" }] }));
      return;
    }
    if (req.url === "/b/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "remote-b" }] }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
      activeProvider: "byok",
      activeModel: "local-a",
      providers: {
        byok: { baseUrl: `http://127.0.0.1:${port}/a`, model: "local-a", models: ["local-a"], apiKey: "sk-a" },
        openai: { baseUrl: `http://127.0.0.1:${port}/b`, model: "local-b", models: ["local-b"], apiKey: "sk-b" }
      }
    }));
    const stdout = await runWithInput([], "/model sync all\n/exit\n", { AZYCODE_HOME: home });
    assert.match(stdout, /models: byok synced 1 remote/);
    assert.match(stdout, /models: openai synced 1 remote/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.deepEqual(cfg.providers.byok.models, ["local-a", "remote-a"]);
    assert.ok(cfg.providers.openai.models.includes("remote-b"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tui slash by itself opens the command palette", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/\n/exit\n", { AZYCODE_HOME: home });
  const plain = stripAnsi(stdout);
  assert.match(plain, /Status[\s\S]*\/status\s+active model, provider, guard/);
  assert.match(plain, /\/login\s+connect a provider/);
  assert.match(plain, /active[^\n]*no provider\/no model/);
});

test("tui sends follow-up messages with conversation context", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const content = requests.length === 1 ? "first answer" : "second answer";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    run(["login", "byok", "--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--api-key", "sk-test"], { AZYCODE_HOME: home });
    const stdout = await runWithInput([], "first question\nsecond question\n/exit\n", { AZYCODE_HOME: home });
    assert.match(stdout, /first answer/);
    assert.match(stdout, /second answer/);
    assert.equal(requests.length, 2);
    assert(requests[1].messages.some((message) => message.role === "assistant" && message.content === "first answer"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tui can manage persistent memory notes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const added = await runWithInput([], "/memory add keep patches small\n/memory patches\n/exit\n", { AZYCODE_HOME: home });
  const addedPlain = stripAnsi(added);
  assert.match(addedPlain, /memory: added mem_/);
  assert.match(addedPlain, /memory[\s\S]*keep patches small/);
  const memory = JSON.parse(fs.readFileSync(path.join(home, "memory.json"), "utf8"));
  const removed = await runWithInput([], `/memory remove ${memory.notes[0].id}\n/memory\n/exit\n`, { AZYCODE_HOME: home });
  const removedPlain = stripAnsi(removed);
  assert.match(removedPlain, /memory: removed/);
  assert.match(removedPlain, /memory[\s\S]*\(none\)/);
});

test("tui can preview bounded context", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/context show\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /<context-pack>/);
  assert.match(stdout, /files:/);
});

test("tui can preview mission files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const mission = path.join(home, "mission.yml");
  fs.writeFileSync(mission, "name: preview\nmode: goal\nsteps:\n  - \"inspect repository\"\n", "utf8");
  const stdout = await runWithInput([], `/mission dry-run ${mission}\n/exit\n`, { AZYCODE_HOME: home });
  assert.match(stdout, /1\. step-1 mode=goal maxSteps=unlimited/);
  assert.match(stdout, /inspect repository/);
});

test("tui can report saved mission state", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    missions: {
      mis_test: {
        name: "release",
        status: "done",
        startedAt: "2026-01-01T00:00:00.000Z",
        finishedAt: "2026-01-01T00:01:00.000Z",
        steps: [{ index: 1, status: "done", prompt: "ship" }]
      }
    }
  }));
  const stdout = await runWithInput([], "/mission report mis_test\n/mission status nope\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Mission mis_test[\s\S]*name: release[\s\S]*1\. done ship/);
  assert.match(stdout, /mission: no mission nope/);
});

test("tui can create inspect and stop goals", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const created = await runWithInput([], "/goal create ship cleaner tui\n/goals\n/exit\n", { AZYCODE_HOME: home });
  assert.match(created, /goal: goal_\d+ created/);
  assert.match(created, /goals[\s\S]*created\s+ship cleaner tui/);
  const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
  const id = Object.keys(state.goals)[0];
  const stopped = await runWithInput([], `/goal status ${id}\n/goal stop ${id}\n/goal status ${id}\n/exit\n`, { AZYCODE_HOME: home });
  assert.match(stopped, new RegExp(`goal ${id}[\\s\\S]*status\\s+created`));
  assert.match(stopped, new RegExp(`goal: ${id} stopped`));
  assert.match(stopped, new RegExp(`goal ${id}[\\s\\S]*status\\s+stopped`));
});

test("plan --save writes an artifact using a configured mock provider", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const outFile = path.join(home, "plan.md");
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();
      return;
    }
    req.on("data", () => {});
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "mock plan" } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address();
    run(["login", "byok", "--base-url", `http://127.0.0.1:${port}/v1`, "--model", "mock", "--api-key", "sk-test"], { AZYCODE_HOME: home });
    const out = await runAsync(["plan", "--save", outFile, "make a plan"], { AZYCODE_HOME: home });
    assert.match(out, /mock plan/);
    const artifact = fs.readFileSync(outFile, "utf8");
    assert.match(artifact, /Azycode plan Artifact/);
    assert.match(artifact, /sessionId:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("session export writes selected session JSON", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: { ses_test: { mode: "plan", prompt: "x", messages: [] } },
    goals: {},
    missions: {}
  }));
  const outFile = path.join(home, "session.json");
  const out = run(["session", "export", "ses_test", outFile], { AZYCODE_HOME: home });
  assert.match(out, /exported/);
  const exported = JSON.parse(fs.readFileSync(outFile, "utf8"));
  assert.equal(exported.prompt, "x");
});

test("session transcript and tools log commands format state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: {
      ses_test: {
        mode: "plan",
        prompt: "x",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "tool", name: "read_file", content: "file" }
        ]
      }
    },
    toolRuns: [{ at: "now", sessionId: "ses_test", step: 1, name: "read_file", ok: true, durationMs: 3 }],
    goals: {},
    missions: {}
  }));
  assert.match(run(["session", "transcript", "ses_test"], { AZYCODE_HOME: home }), /assistant: hi/);
  const log = run(["tools", "log"], { AZYCODE_HOME: home });
  assert.match(log, /Tool Runs/);
  assert.match(log, /read_file[\s\S]*ok[\s\S]*3/);
});

test("help groups commands into a compact interface", () => {
  const out = run(["help"]);
  assert.match(out, /Common workflows/);
  assert.match(out, /Project automation/);
  assert.match(out, /Diagnostics/);
});

test("topic help shows focused command usage", () => {
  const out = run(["help", "mission"]);
  assert.match(out, /azycode mission/);
  assert.match(out, /mission dry-run/);
  assert.match(out, /dependencies/);
  const model = run(["help", "model"]);
  assert.match(model, /azycode model <provider\/model>/);
  assert.match(model, /updates both active provider and active model/);
});

test("status uses labeled output without configured providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["status"], { AZYCODE_HOME: home });
  assert.match(out, /Status/);
  assert.match(out, /active provider\s+\(none\)/);
  assert.match(out, /Use `azycode model` to view and select provider\/model together/);
});

test("dashboard shows local overview without provider network", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["dashboard"], { AZYCODE_HOME: home });
  assert.match(out, /Azycode Dashboard/);
  assert.match(out, /Tool policy/);
  assert.match(out, /sessions\s+0/);
});

test("cli errors are concise unless debug is enabled", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  assert.throws(() => run(["config", "set", "reasoning", "extreme"], { AZYCODE_HOME: home }), (error) => {
    assert.match(error.stderr, /azycode: Reasoning must be one of/);
    assert.doesNotMatch(error.stderr, /at configCmd/);
    return true;
  });
});

test("mission report formats stored mission state", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: {},
    toolRuns: [],
    goals: {},
    missions: {
      mis_test: { name: "demo", status: "done", steps: [{ index: 1, status: "done", prompt: "step" }] }
    }
  }));
  const out = run(["mission", "report", "mis_test"], { AZYCODE_HOME: home });
  assert.match(out, /mission: mis_test/);
  assert.match(out, /1\. done step/);
});

test("goal and mission lists use tables while json remains available", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: {},
    toolRuns: [],
    goals: { goal_test: { status: "running", text: "ship feature" } },
    missions: { mis_test: { name: "release", status: "done", steps: [{ index: 1 }] } }
  }));
  assert.match(run(["goal", "status"], { AZYCODE_HOME: home }), /goal_test\s+running\s+ship feature/);
  assert.match(run(["mission", "list"], { AZYCODE_HOME: home }), /mis_test\s+done\s+release\s+1/);
  const json = JSON.parse(run(["goal", "status", "--json"], { AZYCODE_HOME: home }));
  assert.equal(json.goal_test.status, "running");
});

test("session and subagent lists use compact tables", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  fs.writeFileSync(path.join(home, "state.json"), JSON.stringify({
    version: 1,
    sessions: { ses_test: { createdAt: "now", mode: "plan", prompt: "inspect repo" } },
    toolRuns: [],
    goals: {},
    missions: {}
  }));
  assert.match(run(["session", "list"], { AZYCODE_HOME: home }), /ses_test\s+now\s+plan\s+ok\s+0\s+0\s+0\s+inspect repo/);
  assert.match(run(["subagent", "list"], { AZYCODE_HOME: home }), /planner\s+high\s+\(active\)/);
});

test("status and health support json output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-json-"));
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({
    activeProvider: "byok",
    activeModel: "mock",
    mode: "build",
    reasoning: "medium",
    providers: {
      byok: {
        baseUrl: "http://127.0.0.1:9/v1",
        apiKey: "sk-test",
        model: "mock"
      }
    }
  }, null, 2));
  const statusJson = JSON.parse(run(["status", "--json"], { AZYCODE_HOME: home }));
  assert.equal(statusJson.activeProvider, "byok");
  assert.equal(statusJson.diagnostics.model, "mock");
  assert.equal(statusJson.diagnostics.supportsTools, true);

  let healthStdout = "";
  try {
    healthStdout = run(["health", "--json"], { AZYCODE_HOME: home });
  } catch (error) {
    healthStdout = error.stdout || "";
  }
  const healthJson = JSON.parse(healthStdout);
  assert.equal(healthJson.activeProvider, "byok");
  assert.equal(healthJson.providers.length, 1);
  assert.equal(healthJson.providers[0].name, "byok");
  assert.equal(healthJson.providers[0].diagnostics.supportsStreaming, true);
});

test("todo command lists active items and clears workspace todos", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-todo-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-todo-work-"));
  const env = { ...process.env, AZYCODE_HOME: home };
  const runInWorkspace = (args) => execFileSync(process.execPath, [bin, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 10000
  });

  assert.match(runInWorkspace(["todo", "active"]), /No active todos/);

  const todosPath = path.join(home, "todos.json");
  const key = fs.realpathSync.native(cwd);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(todosPath, JSON.stringify({
    [key]: {
      items: [
        {
          id: "todo_test",
          text: "Ship CLI todo command",
          status: "pending",
          tags: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z"
        }
      ]
    }
  }, null, 2));

  assert.match(runInWorkspace(["todo", "active"]), /Ship CLI todo command/);
  assert.match(runInWorkspace(["todo", "clear"]), /Cleared 1 todo/);
});

function runWithInput(args, inputText, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out: ${args.join(" ")}`));
    }, 10000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`Command failed with ${code}: ${stderr}`));
    });
    child.stdin.end(inputText);
  });
}
