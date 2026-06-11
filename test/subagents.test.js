import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { formatSubagentResults, runSubagentsParallel } from "../src/subagents.js";

function mockChatServer(handler) {
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
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(parsed)));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("runSubagentsParallel runs bounded subagent sessions and formats results", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sub-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sub-work-"));
  process.env.AZYCODE_HOME = home;
  const { server, port } = await mockChatServer(() => ({
    choices: [{ message: { role: "assistant", content: "explorer report" } }]
  }));

  const events = [];
  try {
    const cfg = {
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
        explorer: {
          description: "read-only dig",
          reasoning: "low",
          system: "Explore and report only."
        }
      },
      toolPolicy: {
        read_file: "auto",
        list_files: "auto",
        search: "auto",
        shell: "deny",
        write_file: "deny",
        edit_file: "deny",
        apply_patch: "deny"
      }
    };
    const results = await runSubagentsParallel({
      cfg,
      cwd,
      tasks: [{ agent: "explorer", prompt: "map src/" }],
      maxStepsPerAgent: 2,
      onSubagentEvent: (event) => events.push(event)
    });
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    assert.match(results[0].output, /explorer report/);
    assert.equal(events[0].type, "subagent_start");
    assert.equal(events[1].type, "subagent_end");
    const formatted = formatSubagentResults(results);
    assert.match(formatted, /Subagent 1: explorer \(ok\)/);
  } finally {
    server.close();
  }
});

test("runSubagentsParallel respects subagent nesting depth", async () => {
  const results = await runSubagentsParallel({
    cfg: { subagents: { explorer: { system: "explore", reasoning: "low" } }, maxSubagentDepth: 0 },
    cwd: process.cwd(),
    tasks: [{ agent: "explorer", prompt: "map" }],
    subagentDepth: 0
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /depth limit/i);
});

test("runSubagentsParallel processes tasks beyond maxParallel in batches", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sub-batch-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-sub-batch-work-"));
  process.env.AZYCODE_HOME = home;
  let calls = 0;
  const { server, port } = await mockChatServer(() => {
    calls += 1;
    return {
      choices: [{ message: { role: "assistant", content: `report-${calls}` } }]
    };
  });

  try {
    const cfg = {
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
        explorer: {
          description: "read-only dig",
          reasoning: "low",
          system: "Explore and report only."
        }
      },
      toolPolicy: {
        read_file: "auto",
        list_files: "auto",
        search: "auto",
        shell: "deny",
        write_file: "deny",
        edit_file: "deny",
        apply_patch: "deny"
      }
    };
    const tasks = Array.from({ length: 6 }, (_, index) => ({
      agent: "explorer",
      prompt: `map src/${index}`
    }));
    const results = await runSubagentsParallel({
      cfg,
      cwd,
      tasks,
      maxParallel: 4,
      maxStepsPerAgent: 1
    });
    assert.equal(results.length, 6);
    assert.equal(results.every((result) => result.ok), true);
    assert.deepEqual(results.map((result) => result.index), [1, 2, 3, 4, 5, 6]);
    assert.equal(calls, 6);
  } finally {
    server.close();
  }
});

test("runSubagentsParallel reports unknown subagents without throwing", async () => {
  const results = await runSubagentsParallel({
    cfg: { subagents: {} },
    cwd: process.cwd(),
    tasks: [{ agent: "missing", prompt: "do work" }]
  });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Unknown subagent/);
});