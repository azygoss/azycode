import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadState } from "../src/config.js";
import { runMission } from "../src/missions.js";

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
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(handler(JSON.parse(body))));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

test("runMission records every parallel child step atomically", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-mission-state-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-mission-work-"));
  process.env.AZYCODE_HOME = home;
  const missionFile = path.join(cwd, "mission.json");
  fs.writeFileSync(missionFile, JSON.stringify({
    name: "parallel-state",
    mode: "review",
    steps: [{
      id: "parallel-review",
      parallel: [
        { id: "child-a", agent: "reviewer", prompt: "review a" },
        { id: "child-b", agent: "explorer", prompt: "map b" }
      ]
    }]
  }), "utf8");

  const { server, port } = await mockChatServer((body) => {
    const system = body.messages.find((message) => message.role === "system")?.content || "";
    if (system.includes("strict code review subagent")) {
      return { choices: [{ message: { role: "assistant", content: "review a done" } }] };
    }
    if (system.includes("exploration subagent")) {
      return { choices: [{ message: { role: "assistant", content: "map b done" } }] };
    }
    return { choices: [{ message: { role: "assistant", content: "fallback" } }] };
  });

  try {
    const cfg = {
      activeProvider: "byok",
      activeModel: "mock-coder",
      mode: "review",
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
      },
      toolPolicy: { shell: "deny" }
    };
    await runMission({ cfg, cwd, file: missionFile });
    const mission = Object.values(loadState().missions)[0];
    const childIds = mission.steps.filter((step) => step.parentId === "parallel-review").map((step) => step.id).sort();
    assert.deepEqual(childIds, ["child-a", "child-b"]);
    assert.equal(mission.steps.find((step) => step.id === "parallel-review")?.status, "done");
  } finally {
    server.close();
  }
});