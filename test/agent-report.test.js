import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appendOpenTodosNotice, buildStepLimitReport } from "../src/agent-report.js";
import { addTodo } from "../src/todos.js";

test("buildStepLimitReport includes partial answer and open todos", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-report-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-report-cwd-"));
  process.env.AZYCODE_HOME = home;
  addTodo(cwd, "Verify tests");

  const report = buildStepLimitReport({
    maxSteps: 3,
    partialContent: "Partial plan only",
    cwd,
    style: "cli",
    events: [{ type: "tool_end", step: 2, tool: "read_file", ok: true, durationMs: 8 }]
  });

  assert.match(report, /3 steps/);
  assert.match(report, /Partial plan only/);
  assert.match(report, /Verify tests/);
  assert.match(report, /read_file/);
});

test("appendOpenTodosNotice appends active todos to final answers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-report-home-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-report-cwd-2-"));
  process.env.AZYCODE_HOME = home;
  addTodo(cwd, "Ship patch");

  const text = appendOpenTodosNotice("Done for now.", cwd);
  assert.match(text, /Done for now/);
  assert.match(text, /Ship patch/);
});