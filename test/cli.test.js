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
  assert.match(tools, /Tool Policy/);
  assert.match(tools, /shell\s+deny/);
});

test("health reports no configured providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["health"], { AZYCODE_HOME: home });
  assert.match(out, /No providers configured/);
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
    const out = await runAsync(["models", "sync"], { AZYCODE_HOME: home });
    assert.match(out, /Synced 2 remote models/);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.deepEqual(cfg.providers.byok.models, ["local", "remote-a", "remote-b"]);
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
  assert.match(stdout, /mode=plan/);
  assert.match(stdout, /context=true/);
  assert.match(stdout, /progress=true/);
});

test("default command launches the interactive tui", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/reasoning high\n/mode goal\n/model mock-next\n/profile read-only\n/status\n/compact\n/new\n/dashboard\n/login\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /azycode/);
  assert.match(stdout, /azycode/);
  assert.match(stdout, /type a task\s+\/help commands\s+Tab reasoning\s+Shift\+Tab mode/);
  assert.match(stdout, /no provider\/no model/);
  assert.match(stdout, /Status[\s\S]*provider\s+no provider[\s\S]*model\s+mock-next[\s\S]*mode\s+goal[\s\S]*reasoning\s+high[\s\S]*profile\s+read-only/);
  assert.match(stdout, /conversation: 0 -> 0 messages/);
  assert.match(stdout, /conversation: cleared/);
  assert.match(stdout, /Dashboard/);
  assert.match(stdout, /Interactive login requires a terminal/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeModel, "mock-next");
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
  assert.match(stdout, /Sessions[\s\S]*ses_test\s+goal\s+ship it/);
  assert.match(stdout, /Tool runs[\s\S]*read_file\s+ok\s+3ms\s+ses_test/);
  assert.match(stdout, /Goals[\s\S]*goal_test\s+running\s+ship it/);
  assert.match(stdout, /Missions[\s\S]*mis_test\s+done\s+release/);
});

test("tui can list and select subagents", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/agents\n/agent planner\n/status\n/dashboard\n/agent off\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Subagents[\s\S]*planner\s+high/);
  assert.match(stdout, /agent: @planner/);
  assert.match(stdout, /Status[\s\S]*agent\s+planner/);
  assert.match(stdout, /agent\s+planner/);
  assert.match(stdout, /agent: off/);
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
  assert.match(stdout, /Providers[\s\S]*byok\s+configured\s+local/);
  assert.match(stdout, /provider: kimi\/kimi-test/);
  assert.match(stdout, /kimi\/kimi-test/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeProvider, "kimi");
  assert.equal(cfg.activeModel, "kimi-test");
});

test("tui can inspect and update tool policy", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/policy\n/tool shell auto\n/policy\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Tool policy[\s\S]*shell\s+ask/);
  assert.match(stdout, /tool: shell -> auto/);
  assert.match(stdout, /Tool policy[\s\S]*shell\s+auto/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.toolPolicy.shell, "auto");
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
  assert.match(stdout, /Models \(byok\)[\s\S]*\* old[\s\S]*candidate/);
  assert.match(stdout, /model: candidate/);
  const cfg = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  assert.equal(cfg.activeModel, "candidate");
  assert.deepEqual(cfg.providers.byok.models, ["old", "candidate"]);
});

test("tui slash by itself opens the command palette", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const stdout = await runWithInput([], "/\n/exit\n", { AZYCODE_HOME: home });
  assert.match(stdout, /Commands[\s\S]*\/status\s+active model/);
  assert.match(stdout, /\/login\s+connect a provider/);
  assert.match(stdout, /active: no provider\/no model/);
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
    assert.match(stdout, /assistant\s+first answer/);
    assert.match(stdout, /assistant\s+second answer/);
    assert.equal(requests.length, 2);
    assert(requests[1].messages.some((message) => message.role === "assistant" && message.content === "first answer"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("tui can manage persistent memory notes", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const added = await runWithInput([], "/memory add keep patches small\n/memory patches\n/exit\n", { AZYCODE_HOME: home });
  assert.match(added, /memory: added mem_/);
  assert.match(added, /Memory[\s\S]*keep patches small/);
  const memory = JSON.parse(fs.readFileSync(path.join(home, "memory.json"), "utf8"));
  const removed = await runWithInput([], `/memory remove ${memory.notes[0].id}\n/memory\n/exit\n`, { AZYCODE_HOME: home });
  assert.match(removed, /memory: removed/);
  assert.match(removed, /Memory\s+\(none\)/);
});

test("tui can preview mission files", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const mission = path.join(home, "mission.yml");
  fs.writeFileSync(mission, "name: preview\nmode: goal\nsteps:\n  - \"inspect repository\"\n", "utf8");
  const stdout = await runWithInput([], `/mission dry-run ${mission}\n/exit\n`, { AZYCODE_HOME: home });
  assert.match(stdout, /1\. step-1 mode=goal maxSteps=12/);
  assert.match(stdout, /inspect repository/);
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
  assert.match(log, /read_file\s+true/);
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
});

test("status uses labeled output without configured providers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cli-"));
  const out = run(["status"], { AZYCODE_HOME: home });
  assert.match(out, /Status/);
  assert.match(out, /active provider\s+\(none\)/);
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
  assert.match(run(["session", "list"], { AZYCODE_HOME: home }), /ses_test\s+now\s+plan\s+inspect repo/);
  assert.match(run(["subagent", "list"], { AZYCODE_HOME: home }), /planner\s+high\s+\(active\)/);
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
