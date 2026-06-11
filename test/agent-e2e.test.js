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
  assert.match(plan, /bounded tools deliberately/);
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

test("runMission can execute parallel step groups and emit mission events", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const missionFile = path.join(cwd, "mission.json");
  fs.writeFileSync(missionFile, JSON.stringify({
    name: "parallel-mission",
    mode: "review",
    passContext: true,
    steps: [
      { id: "plan", prompt: "plan review" },
      {
        id: "parallel-review",
        dependsOn: "plan",
        parallel: [
          { id: "review-diff", agent: "reviewer", prompt: "review diff" },
          { id: "map-src", agent: "explorer", prompt: "map src" }
        ]
      },
      { id: "summarize", dependsOn: "parallel-review", prompt: "summarize findings" }
    ]
  }), "utf8");

  const { server, port } = await mockChatServer((body) => {
    const user = body.messages.at(-1)?.content || "";
    if (user.includes("summarize findings")) {
      assert.match(user, /review findings/);
      assert.match(user, /mapped src/);
      return { choices: [{ message: { role: "assistant", content: "final summary" } }] };
    }
    const system = body.messages.find((message) => message.role === "system")?.content || "";
    if (system.includes("strict code review subagent")) return { choices: [{ message: { role: "assistant", content: "review findings" } }] };
    if (system.includes("exploration subagent")) return { choices: [{ message: { role: "assistant", content: "mapped src" } }] };
    return { choices: [{ message: { role: "assistant", content: "planned" } }] };
  });

  try {
    const events = [];
    const cfg = {
      ...cfgFor(port),
      subagents: {
        reviewer: {
          description: "reviewer",
          reasoning: "low",
          system: "You are Azycode's strict code review subagent.",
          model: "mock-coder"
        },
        explorer: {
          description: "explorer",
          reasoning: "low",
          system: "You are Azycode's exploration subagent.",
          model: "mock-coder"
        }
      }
    };
    const result = await runMission({
      cfg,
      cwd,
      file: missionFile,
      onEvent: (event) => events.push(event)
    });
    assert.equal(result.outputs.at(-1).output, "final summary");
    assert(events.some((event) => event.type === "mission_start"));
    assert(events.some((event) => event.type === "mission_step_start" && event.id === "parallel-review" && event.parallel === 2));
    assert(events.some((event) => event.type === "mission_end" && event.status === "done"));
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    const mission = Object.values(state.missions)[0];
    assert.equal(mission.status, "done");
    assert.equal(mission.steps.find((step) => step.id === "parallel-review").status, "done");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent emits tool events for invalid tool-call JSON", async () => {
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
    const events = [];
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "bad args", onEvent: (event) => events.push(event) });
    assert.equal(output, "recovered");
    assert.equal(calls.length, 2);
    assert(events.some((event) => event.type === "tool_start" && event.tool === "write_file"));
    assert(events.some((event) => event.type === "tool_end" && event.ok === false && event.code === "invalid_args"));
    assert(events.some((event) => event.type === "agent_run_end" && event.status === "ok"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent executes independent read-only tools in parallel", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.writeFileSync(path.join(cwd, "a.txt"), "alpha\n", "utf8");
  fs.writeFileSync(path.join(cwd, "b.txt"), "beta\n", "utf8");
  let sawParallelReads = false;
  const { server, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file: "a.txt" }) } },
              { id: "call_b", type: "function", function: { name: "read_file", arguments: JSON.stringify({ file: "b.txt" }) } }
            ]
          }
        }]
      };
    }
    const toolMessages = body.messages.filter((message) => message.role === "tool");
    sawParallelReads = toolMessages.length === 2;
    return { choices: [{ message: { role: "assistant", content: "read both" } }] };
  });

  try {
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "read files" });
    assert.equal(output, "read both");
    assert.equal(sawParallelReads, true);
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
    sawContext = body.messages[0].content.includes("<context-pack>") && body.messages[0].content.includes("README.md");
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

test("runAgent persists session events for transcript replay", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, port } = await mockChatServer(() => ({
    choices: [{ message: { role: "assistant", content: "eventful" } }]
  }));

  try {
    const result = await runAgent({ cfg: cfgFor(port), cwd, prompt: "record events", returnSession: true });
    assert.equal(result.content, "eventful");
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    const session = state.sessions[result.sessionId];
    assert(session.events.some((event) => event.type === "agent_run_start"));
    assert(session.events.some((event) => event.type === "agent_run_end" && event.status === "ok"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent honours abort signal during a long shell tool", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const controller = new AbortController();
  const { server, port } = await mockChatServer(() => ({
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          id: "call_shell",
          type: "function",
          function: {
            name: "shell",
            arguments: JSON.stringify({
              command: process.platform === "win32" ? "timeout 30" : "sleep 30",
              timeoutMs: 60_000
            })
          }
        }]
      }
    }]
  }));
  const cfg = {
    ...cfgFor(port),
    toolPolicy: { ...cfgFor(port).toolPolicy, shell: "auto" },
    gitGuard: { enabled: false },
    toolTimeoutMs: 120_000
  };
  try {
    const started = Date.now();
    const promise = runAgent({ cfg, cwd, prompt: "sleep", signal: controller.signal });
    setTimeout(() => controller.abort(), 120);
    await assert.rejects(promise, /cancelled/i);
    assert.ok(Date.now() - started < 3000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent honours abort signal before model turn", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const controller = new AbortController();
  controller.abort();
  const { server, port } = await mockChatServer(() => ({
    choices: [{ message: { role: "assistant", content: "nope" } }]
  }));
  try {
    await assert.rejects(
      () => runAgent({ cfg: cfgFor(port), cwd, prompt: "cancel me", signal: controller.signal }),
      /cancelled/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent can spawn parallel subagents via spawn_subagents tool", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, port } = await mockChatServer((body) => {
    const system = body.messages.find((message) => message.role === "system")?.content || "";
    if (system.includes("exploration subagent")) {
      return { choices: [{ message: { role: "assistant", content: "mapped src" } }] };
    }
    if (body.messages.some((message) => message.role === "tool" && message.name === "spawn_subagents")) {
      return { choices: [{ message: { role: "assistant", content: "parallel work complete" } }] };
    }
    return {
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "call_spawn",
            type: "function",
            function: {
              name: "spawn_subagents",
              arguments: JSON.stringify({
                tasks: [{ agent: "explorer", prompt: "map src/" }]
              })
            }
          }]
        }
      }]
    };
  });

  try {
    const events = [];
    const output = await runAgent({
      cfg: {
        ...cfgFor(port),
        subagents: {
          explorer: {
            description: "read-only dig",
            reasoning: "low",
            system: "You are Azycode's exploration subagent.",
            model: "mock-coder"
          }
        },
        toolPolicy: {
          ...cfgFor(port).toolPolicy,
          spawn_subagents: "auto"
        }
      },
      cwd,
      prompt: "explore in parallel",
      mode: "always-approve",
      onEvent: (event) => events.push(event)
    });
    assert.equal(output, "parallel work complete");
    assert(events.some((event) => event.type === "subagent_start" && event.agent === "explorer"));
    assert(events.some((event) => event.type === "subagent_end" && event.agent === "explorer" && event.ok));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent applies pre_tool hook modifications before executing tools", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(path.join(cwd, ".azycode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "hooked.txt"), "hooked content\n", "utf8");
  const hookScript = [
    "const payload = JSON.parse(process.env.AZYCODE_HOOK_PAYLOAD || '{}');",
    "if (payload.tool === 'read_file') {",
    "  console.log(JSON.stringify({ modify: { args: { ...payload.args, file: 'hooked.txt' } } }));",
    "}"
  ].join("");
  fs.writeFileSync(path.join(cwd, ".azycode", "hooks.json"), JSON.stringify({
    pre_tool: [{ command: "node", args: ["-e", hookScript] }]
  }), "utf8");

  const { server, calls, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_read",
              type: "function",
              function: {
                name: "read_file",
                arguments: JSON.stringify({ file: "missing.txt" })
              }
            }]
          }
        }]
      };
    }
    const toolMessage = body.messages.at(-1);
    assert.equal(toolMessage.role, "tool");
    assert.match(toolMessage.content, /hooked content/);
    return { choices: [{ message: { role: "assistant", content: "read via hook" } }] };
  });

  try {
    const events = [];
    const output = await runAgent({
      cfg: cfgFor(port),
      cwd,
      prompt: "read the file",
      onEvent: (event) => events.push(event)
    });
    assert.equal(output, "read via hook");
    assert.equal(calls.length, 2);
    assert(events.some((event) => event.type === "tool_start" && event.tool === "read_file"));
    assert(events.some((event) => event.type === "tool_end" && event.tool === "read_file" && event.ok));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent stops before model turn when agent_run_start hook blocks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(path.join(cwd, ".azycode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".azycode", "hooks.json"), JSON.stringify({
    agent_run_start: [{ command: "echo", args: ['{"block":true,"message":"policy denied"}'] }]
  }), "utf8");

  const { server, calls, port } = await mockChatServer(() => {
    throw new Error("model should not be called");
  });

  try {
    const events = [];
    const output = await runAgent({
      cfg: cfgFor(port),
      cwd,
      prompt: "blocked run",
      returnSession: true,
      onEvent: (event) => events.push(event)
    });
    assert.match(output.content, /policy denied/);
    assert.equal(calls.length, 0);
    assert(events.some((event) => event.type === "agent_run_end" && event.status === "blocked"));
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.equal(state.sessions[output.sessionId].stopped, "blocked");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent surfaces pre_tool hook blocks as rejected tool results", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(path.join(cwd, ".azycode"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".azycode", "hooks.json"), JSON.stringify({
    pre_tool: [{ command: "echo", args: ['{"block":true,"message":"shell blocked by policy"}'] }]
  }), "utf8");

  const { server, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_shell",
              type: "function",
              function: {
                name: "shell",
                arguments: JSON.stringify({ command: "echo nope" })
              }
            }]
          }
        }]
      };
    }
    const toolMessage = body.messages.at(-1);
    assert.match(toolMessage.content, /blocked by hook/);
    return { choices: [{ message: { role: "assistant", content: "policy handled" } }] };
  });

  try {
    const events = [];
    const output = await runAgent({
      cfg: { ...cfgFor(port), toolPolicy: { ...cfgFor(port).toolPolicy, shell: "auto" }, gitGuard: { enabled: false } },
      cwd,
      prompt: "run shell",
      onEvent: (event) => events.push(event)
    });
    assert.equal(output, "policy handled");
    assert(events.some((event) => event.type === "tool_end" && event.tool === "shell" && event.code === "rejected"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent honours post_model skipTools hook filter", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(path.join(cwd, ".azycode"), { recursive: true });
  const hookScript = [
    "const payload = JSON.parse(process.env.AZYCODE_HOOK_PAYLOAD || '{}');",
    "if (payload.tools?.includes('write_file')) {",
    "  console.log(JSON.stringify({ modify: { skipTools: ['write_file'] } }));",
    "}"
  ].join("");
  fs.writeFileSync(path.join(cwd, ".azycode", "hooks.json"), JSON.stringify({
    post_model: [{ command: "node", args: ["-e", hookScript] }]
  }), "utf8");

  const { server, calls, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            content: "skipped write",
            tool_calls: [{
              id: "call_write",
              type: "function",
              function: {
                name: "write_file",
                arguments: JSON.stringify({ file: "blocked.txt", content: "nope\n" })
              }
            }]
          }
        }]
      };
    }
    throw new Error("model should not be called again when tools are skipped");
  });

  try {
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "write a file" });
    assert.equal(output, "skipped write");
    assert.equal(calls.length, 1);
    assert.equal(fs.existsSync(path.join(cwd, "blocked.txt")), false);
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
