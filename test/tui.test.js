import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyShortcut, loginProvider, trimConversation } from "../src/tui.js";

test("trimConversation starts retained context at a user boundary", () => {
  const messages = [
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "assistant", content: "tool request" },
    { role: "tool", content: "tool output" },
    { role: "user", content: "recent question" },
    { role: "assistant", content: "recent answer" }
  ];
  const trimmed = trimConversation(messages, 3);
  assert.deepEqual(trimmed, messages.slice(4));
  assert.equal(trimmed[0].role, "user");
});

test("trimConversation leaves short conversations untouched", () => {
  const messages = [{ role: "user", content: "hello" }];
  assert.equal(trimConversation(messages), messages);
});

test("applyShortcut rotates reasoning and mode without persistence when requested", () => {
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  const events = [];
  const options = { persist: false, notify: (message) => events.push(message) };
  applyShortcut({ name: "tab" }, state, options);
  applyShortcut({ name: "tab", shift: true }, state, options);
  assert.equal(state.cfg.reasoning, "high");
  assert.equal(state.mode, "always-approve");
  assert.deepEqual(events, ["reasoning: high", "mode: always-approve"]);
});

test("loginProvider selects a preset and stores only the entered key", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  process.env.AZYCODE_HOME = home;
  const answers = ["2", "sk-kimi"];
  const state = { cfg: { providers: {} } };
  await loginProvider(state, { question: async () => answers.shift() });
  assert.equal(state.cfg.activeProvider, "kimi");
  assert.equal(state.cfg.activeModel, "kimi-k2.6");
  assert.deepEqual(state.cfg.providers.kimi, {
    baseUrl: "https://api.moonshot.ai/v1",
    model: "kimi-k2.6",
    apiKey: "sk-kimi"
  });
});

test("loginProvider asks BYOK for endpoint and model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  process.env.AZYCODE_HOME = home;
  const answers = ["6", "sk-local", "http://127.0.0.1:11434/v1", "local-coder"];
  const state = { cfg: { providers: {} } };
  await loginProvider(state, { question: async () => answers.shift() });
  assert.equal(state.cfg.activeProvider, "byok");
  assert.equal(state.cfg.activeModel, "local-coder");
  assert.deepEqual(state.cfg.providers.byok, {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "local-coder",
    apiKey: "sk-local"
  });
});
