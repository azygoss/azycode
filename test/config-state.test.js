import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadState, updateState } from "../src/config.js";

test("updateState retries when state file changes concurrently", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-state-race-"));
  process.env.AZYCODE_HOME = home;
  updateState((state) => {
    state.toolRuns.push({ name: "first", ok: true });
    return state;
  });
  updateState((state) => {
    state.toolRuns.push({ name: "second", ok: true });
    return state;
  });
  const state = loadState();
  assert.equal(state.toolRuns.length, 2);
  assert.equal(state.toolRuns[0].name, "first");
  assert.equal(state.toolRuns[1].name, "second");
  assert.ok(state.version >= 2);
});

test("updateState atomically appends tool runs", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-state-"));
  process.env.AZYCODE_HOME = home;
  updateState((state) => {
    state.toolRuns.push({ name: "read_file", ok: true, durationMs: 1 });
    return state;
  });
  updateState((state) => {
    state.toolRuns.push({ name: "search", ok: true, durationMs: 2 });
    return state;
  });
  const state = loadState();
  assert.equal(state.toolRuns.length, 2);
  assert.equal(state.toolRuns[0].name, "read_file");
  assert.equal(state.toolRuns[1].name, "search");
});