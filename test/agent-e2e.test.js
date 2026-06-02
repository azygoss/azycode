import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runAgent, systemForMode } from "../src/agent.js";
import { runMission } from "../src/missions.js";

function mockChatServer(handler) {
  const calls = [];
  const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push(parsed);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(parsed, calls.length)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, calls, port: server.address().port }));
  });
}

function cfgFor(port) {
  return {
    activeProvider: "byok",
    activeModel: "mock-coder",
    mode: "always-approve",
    reasoning: "medium",
    alwaysApprove: true,
    providers: {
      byok: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "sk-test",
        model: "mock-coder"
      }
    },
    subagents: {
      implementer: {
        system: "You write files when requested.",
        reasoning: "low",
        model: "mock-coder"
      }
    },
    toolPolicy: {
      write_file: "auto",
      read_file: "auto",
      list_files: "auto",
      search: "auto",
      shell: "deny",
      apply_patch: "auto",
      git_diff: "auto",
      todo: "auto",
      set_mode: "auto"
    }
  };
}

test("system prompts describe tool discipline and mode behavior", () => {
  const plan = systemForMode("plan");
  assert.match(plan, /Use bounded tools deliberately/);
  assert.match(plan, /todo tool/);
  assert.match(plan, /set_mode/);
  assert.match(plan, /Do not modify files/);
  const review = systemForMode("review");
  assert.match(review, /strict code reviewer/);
  assert.match(review, /security risks/);
});

test("runAgent can switch to plan mode mid-run via set_mode tool", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, calls, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_mode",
              type: "function",
              function: {
                name: "set_mode",
                arguments: JSON.stringify({ mode: "plan", reason: "inspect before editing" })
              }
            }]
          }
        }]
      };
    }
    if (count === 2) {
      const system = body.messages.find((message) => message.role === "system")?.content || "";
      assert.match(system, /Plan mode/);
      return { choices: [{ message: { role: "assistant", content: "planned" } }] };
    }
    throw new Error(`unexpected model call ${count}`);
  });

  try {
    const events = [];
    const output = await runAgent({
      cfg: cfgFor(port),
      cwd,
      prompt: "plan this change",
      mode: "always-approve",
      onEvent: (event) => events.push(event)
    });
    assert.equal(output, "planned");
    assert(events.some((event) => event.type === "mode_change" && event.mode === "plan"));
    assert.equal(calls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent performs real tool-call write and records a session", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ file: "created.txt", content: "hello from tool\n" })
              }
            }]
          }
        }]
      };
    }
    assert.equal(body.messages.at(-1).role, "tool");
    return { choices: [{ message: { role: "assistant", content: "done" } }] };
  });

  try {
    const events = [];
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "create a file", onEvent: (event) => events.push(event) });
    assert.equal(output, "done");
    assert.equal(fs.readFileSync(path.join(cwd, "created.txt"), "utf8"), "hello from tool\n");
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.equal(Object.keys(state.sessions).length, 1);
    assert(state.toolRuns.some((run) => run.name === "write_file" && run.ok));
    assert(events.some((event) => event.type === "tool_start"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runMission can execute a step through a configured subagent", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const missionFile = path.join(cwd, "mission.json");
  fs.writeFileSync(missionFile, JSON.stringify({
    name: "mock-mission",
    mode: "always-approve",
    steps: [{ agent: "implementer", prompt: "write mission output" }]
  }), "utf8");

  const { server, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ file: "mission.txt", content: "mission ok\n" })
              }
            }]
          }
        }]
      };
    }
    return { choices: [{ message: { role: "assistant", content: "mission done" } }] };
  });

  try {
    const result = await runMission({ cfg: cfgFor(port), cwd, file: missionFile });
    assert.equal(result.outputs[0].output, "mission done");
    assert.equal(fs.readFileSync(path.join(cwd, "mission.txt"), "utf8"), "mission ok\n");
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    const mission = Object.values(state.missions)[0];
    assert.equal(mission.status, "done");
    assert.equal(mission.steps[0].status, "done");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent reports invalid tool-call JSON back to the model instead of crashing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, calls, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_bad",
              type: "function",
              function: { name: "write_file", arguments: "{" }
            }]
          }
        }]
      };
    }
    assert.match(body.messages.at(-1).content, /invalid JSON/);
    return { choices: [{ message: { role: "assistant", content: "recovered" } }] };
  });

  try {
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "bad args" });
    assert.equal(output, "recovered");
    assert.equal(calls.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent uses the provider-resolved model when activeModel is stale", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, calls, port } = await mockChatServer(() => ({
    choices: [{ message: { role: "assistant", content: "ok" } }]
  }));
  try {
    const cfg = cfgFor(port);
    cfg.activeModel = "stale-model";
    const output = await runAgent({ cfg, cwd, prompt: "hello" });
    assert.equal(output, "ok");
    assert.equal(calls[0].model, "mock-coder");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent can include a context pack in the system prompt", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.writeFileSync(path.join(cwd, "README.md"), "# context\n");
  let sawContext = false;
  const { server, port } = await mockChatServer((body) => {
    sawContext = body.messages[0].content.includes("Context Pack") && body.messages[0].content.includes("README.md");
    return { choices: [{ message: { role: "assistant", content: "ok" } }] };
  });

  try {
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "use context", includeContext: true });
    assert.equal(output, "ok");
    assert.equal(sawContext, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent carries conversation messages into a follow-up run", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  let sawHistory = false;
  const { server, port } = await mockChatServer((body) => {
    sawHistory = body.messages.some((message) => message.role === "assistant" && message.content === "previous answer");
    return { choices: [{ message: { role: "assistant", content: "follow-up answer" } }] };
  });

  try {
    const result = await runAgent({
      cfg: cfgFor(port),
      cwd,
      prompt: "follow up",
      conversation: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "previous answer" }
      ],
      returnSession: true
    });
    assert.equal(result.content, "follow-up answer");
    assert.equal(sawHistory, true);
    assert.equal(result.messages.at(-1).content, "follow-up answer");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
