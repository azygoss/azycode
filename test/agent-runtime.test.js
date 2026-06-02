import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModeRuntime } from "../src/agent-runtime.js";
import { loadConfig } from "../src/config.js";

test("createModeRuntime switches mode and can persist to config", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-mode-"));
  process.env.AZYCODE_HOME = home;
  const cfg = loadConfig();
  cfg.mode = "always-approve";

  const events = [];
  const runtime = createModeRuntime("always-approve", {
    cfg,
    onModeChange: (payload) => events.push(payload)
  });

  const result = runtime.setMode("plan", { reason: "inspect first", persist: true });
  assert.equal(result.mode, "plan");
  assert.equal(result.previous, "always-approve");
  assert.equal(runtime.getMode(), "plan");
  assert.equal(runtime.consumeModeChange(), "plan");
  assert.equal(runtime.consumeModeChange(), null);
  assert.equal(loadConfig().mode, "plan");
  assert.equal(events.length, 1);
  assert.equal(events[0].reason, "inspect first");
});