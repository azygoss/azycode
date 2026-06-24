import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runAgent, systemForMode } from "../src/agent.js";
import { AgentStepLimitError } from "../src/agent-errors.js";

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
    toolPolicy: {
      write_file: "auto", read_file: "auto", list_files: "auto", search: "auto",
      shell: "deny", apply_patch: "auto", git_diff: "auto", todo: "auto", set_mode: "auto"
    }
  };
}

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-agent-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-agent-work-"));
  process.env.AZYCODE_HOME = home;
  return { home, cwd };
}

test("runAgent throws AgentStepLimitError when maxSteps is exhausted", async () => {
  const { home, cwd } = freshHome();
  // Every turn requests a tool, so the agent never produces a final answer.
  const { server, port } = await mockChatServer(() => ({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call_loop",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ file: "none.txt" }) }
        }]
      }
    }]
  }));
  try {
    await assert.rejects(
      () => runAgent({ cfg: cfgFor(port), cwd, prompt: "loop forever", maxSteps: 2 }),
      (error) => {
        assert.ok(error instanceof AgentStepLimitError, "should be AgentStepLimitError");
        assert.equal(error.maxSteps, 2);
        return true;
      }
    );
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    const session = Object.values(state.sessions)[0];
    assert.equal(session.stopped, "step_limit");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent rejects unknown tool name and recovers", async () => {
  const { cwd } = freshHome();
  const { server, calls, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_unknown",
              type: "function",
              function: { name: "nonexistent_tool", arguments: "{}" }
            }]
          }
        }]
      };
    }
    // Second turn: the tool result reports "Unknown tool".
    const toolMessage = body.messages.at(-1);
    assert.equal(toolMessage.role, "tool");
    assert.match(toolMessage.content, /Unknown tool/);
    return { choices: [{ message: { role: "assistant", content: "recovered from unknown tool" } }] };
  });
  try {
    const events = [];
    const output = await runAgent({ cfg: cfgFor(port), cwd, prompt: "use bad tool", onEvent: (e) => events.push(e) });
    assert.equal(output, "recovered from unknown tool");
    assert.equal(calls.length, 2);
    assert(events.some((e) => e.type === "tool_end" && e.ok === false));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent surfaces provider 500 error as agent_error", async () => {
  const { cwd } = freshHome();
  const server = http.createServer((req, res) => {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "internal server error" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const events = [];
    await assert.rejects(
      () => runAgent({ cfg: cfgFor(port), cwd, prompt: "trigger 500", onEvent: (e) => events.push(e) }),
      /internal server error|500|fetch/i
    );
    assert(events.some((e) => e.type === "agent_error" || e.type === "agent_run_end" && e.status === "error"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runAgent surfaces provider 401 auth error", async () => {
  const { cwd } = freshHome();
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { message: "invalid api key" } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await assert.rejects(
      () => runAgent({ cfg: cfgFor(port), cwd, prompt: "bad key" }),
      /401|invalid api key|unauthorized/i
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("systemForMode returns substantive prompts for each mode", () => {
  const modes = ["plan", "build", "review", "goal", "always-approve"];
  for (const mode of modes) {
    const p = systemForMode(mode);
    assert.ok(typeof p === "string" && p.length > 20, `${mode} prompt should be substantive`);
  }
  // Plan and review must carry mode-specific guidance.
  assert.match(systemForMode("plan"), /Plan mode|bounded tools|Do not modify files/i);
  assert.match(systemForMode("review"), /code review|security/i);
});

test("runAgent records a tool_run entry on success", async () => {
  const { home, cwd } = freshHome();
  const { server, port } = await mockChatServer((body, count) => {
    if (count === 1) {
      return {
        choices: [{
          message: {
            role: "assistant",
            tool_calls: [{
              id: "call_w",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ file: "a.txt", content: "hi\n" }) }
            }]
          }
        }]
      };
    }
    return { choices: [{ message: { role: "assistant", content: "wrote" } }] };
  });
  try {
    await runAgent({ cfg: cfgFor(port), cwd, prompt: "write a" });
    const state = JSON.parse(fs.readFileSync(path.join(home, "state.json"), "utf8"));
    assert.ok(state.toolRuns.some((r) => r.name === "write_file" && r.ok), "toolRun should be recorded");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
