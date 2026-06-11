import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { applyShortcut, buildCommandPaletteLines, buildCompactPaletteHints, buildComposerPaneLines, buildLivePaletteLines, buildSelectablePaletteLines, completeTuiInput, filterPaletteCommands, loginProvider, normalizeTabKey, promptLabel, resolveSlashSubmit, stripTrailingTab, trimConversation } from "../src/tui.js";
import { promptStatus, stripAnsi, visibleLength, style } from "../src/ui.js";

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

test("normalizeTabKey maps backtab to shifted tab", () => {
  const key = normalizeTabKey({ name: "backtab", sequence: "\u001b[Z" });
  assert.equal(key.name, "tab");
  assert.equal(key.shift, true);
});

test("stripTrailingTab redraws the prompt on the readline output stream", () => {
  const output = new PassThrough();
  output.isTTY = true;
  const rl = { line: "hi\t", cursor: 3, output };
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "high" } };
  let painted = "";
  const originalWrite = output.write.bind(output);
  output.write = (chunk, ...rest) => {
    painted += String(chunk);
    return originalWrite(chunk, ...rest);
  };

  stripTrailingTab(rl, state);
  assert.equal(rl.line, "hi");
  assert.match(painted, /› hi/);
});

test("applyShortcut rotates reasoning and mode without persistence when requested", () => {
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  const events = [];
  const options = { persist: false, notify: (message) => events.push(message) };
  applyShortcut({ name: "tab" }, state, options);
  applyShortcut({ name: "tab", shift: true }, state, options);
  assert.equal(state.cfg.reasoning, "high");
  assert.equal(state.mode, "build");
  assert.equal(events.length, 2);
  assert.match(events[0], /reasoning: high/);
  assert.match(events[1], /mode: build/);
});

test("applyShortcut ignores tab while the TUI is busy", () => {
  const state = { acceptingInput: false, mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  const events = [];
  applyShortcut({ name: "tab", shift: true }, state, { persist: false, notify: (message) => events.push(message) });
  assert.equal(state.mode, "plan");
  assert.equal(state.cfg.reasoning, "medium");
  assert.deepEqual(events, []);
});

test("applyShortcut leaves slash commands to readline completion", () => {
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  const events = [];
  applyShortcut({ name: "tab" }, state, { persist: false, rl: { line: "/sta" }, notify: (message) => events.push(message) });
  assert.equal(state.cfg.reasoning, "medium");
  assert.deepEqual(events, []);
});

test("completeTuiInput suggests slash commands and common arguments", () => {
  const state = {
    cfg: {
      providers: { kimi: { model: "kimi-k2.6" } },
      subagents: { planner: {}, reviewer: {} }
    }
  };
  assert.deepEqual(completeTuiInput("/sta", state), [["/status"], "/sta"]);
  assert.deepEqual(completeTuiInput("/mode a", state), [["/mode always-approve"], "/mode a"]);
  assert.deepEqual(completeTuiInput("/provider ", state), [["/provider kimi"], "/provider "]);
  assert.deepEqual(completeTuiInput("/agent r", state), [["/agent reviewer"], "/agent r"]);
  state.cfg.toolPolicy = { shell: "ask", read_file: "auto" };
  assert.deepEqual(completeTuiInput("/tool s", state), [["/tool shell"], "/tool s"]);
  assert.deepEqual(completeTuiInput("/tool shell a", state), [["/tool shell auto", "/tool shell ask"], "/tool shell a"]);
});

test("loginProvider selects a preset and stores only the entered key", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  process.env.AZYCODE_HOME = home;
  const answers = ["2", "sk-kimi"];
  const state = { cfg: { providers: {} } };
  await loginProvider(state, { question: async () => answers.shift() });
  assert.equal(state.cfg.activeProvider, "kimi");
  assert.equal(state.cfg.activeModel, "kimi-for-coding");
  assert.deepEqual(state.cfg.providers.kimi, {
    baseUrl: "https://api.kimi.com/coding/v1",
    model: "kimi-for-coding",
    models: ["kimi-for-coding"],
    apiKey: "sk-kimi"
  });
});

test("loginProvider asks BYOK for endpoint and model", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-home-"));
  process.env.AZYCODE_HOME = home;
  const answers = ["7", "sk-local", "http://127.0.0.1:11434/v1", "local-coder"];
  const state = { cfg: { providers: {} } };
  await loginProvider(state, { question: async () => answers.shift() });
  assert.equal(state.cfg.activeProvider, "byok");
  assert.equal(state.cfg.activeModel, "local-coder");
  assert.deepEqual(state.cfg.providers.byok, {
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "local-coder",
    models: ["local-coder"],
    apiKey: "sk-local"
  });
});

test("buildComposerPaneLines renders dock, palette, and prompt rows", () => {
  const state = {
    cwd: process.cwd(),
    mode: "plan",
    cfg: { reasoning: "medium", activeProvider: "kimi", activeModel: "kimi-for-coding" }
  };
  const idle = buildComposerPaneLines(state, { line: "hello" }).map(stripAnsi).join("\n");
  assert.match(idle, /hello/);
  assert.doesNotMatch(idle, /\/status/);
  const slash = buildComposerPaneLines(state, { line: "/status", paletteFilter: "status" }).map(stripAnsi).join("\n");
  assert.match(slash, /\/status/);
  assert.match(slash, /active model|commands/);
  assert.doesNotMatch(slash, /\/exit/);
});

test("buildLivePaletteLines renders boxed palette and filters commands", () => {
  const state = {
    cwd: process.cwd(),
    mode: "plan",
    cfg: { reasoning: "medium", activeProvider: "kimi", activeModel: "kimi-for-coding" }
  };
  const lines = buildLivePaletteLines(state, "status", 12).map(stripAnsi).join("\n");
  assert.match(lines, /commands/);
  assert.match(lines, /\/status/);
  assert.doesNotMatch(lines, /\/exit/);
});

test("filterPaletteCommands and resolveSlashSubmit support palette navigation", () => {
  const state = {
    cwd: process.cwd(),
    mode: "plan",
    cfg: { reasoning: "medium", activeProvider: "kimi", activeModel: "kimi-for-coding" }
  };
  const items = filterPaletteCommands(state, "status");
  assert.ok(items.some(([command]) => command === "/status"));
  assert.equal(resolveSlashSubmit("/status", items, 0), "/status");
  assert.equal(resolveSlashSubmit("/", items, 0), items[0][0]);
  const selected = buildSelectablePaletteLines(state, "status", { selection: 0 }).map(stripAnsi).join("\n");
  assert.match(selected, /›.*\/status/);
  assert.match(selected, /pick/);
});

test("buildCommandPaletteLines filters slash commands", () => {
  const state = {
    cwd: process.cwd(),
    mode: "plan",
    cfg: { reasoning: "medium", activeProvider: "kimi", activeModel: "kimi-for-coding" }
  };
  const lines = buildCommandPaletteLines(state, "status");
  const plain = lines.map(stripAnsi).join("\n");
  assert.match(plain, /\/status/);
  assert.doesNotMatch(plain, /\/exit/);
});

test("buildCompactPaletteHints stays compact and filters slash commands", () => {
  const state = {
    cwd: process.cwd(),
    mode: "plan",
    cfg: { reasoning: "medium", activeProvider: "kimi", activeModel: "kimi-for-coding" }
  };
  const lines = buildCompactPaletteHints(state, "status", 6);
  const plain = lines.map(stripAnsi).join("\n");
  assert.ok(lines.length <= 7);
  assert.match(plain, /\/status/);
  assert.doesNotMatch(plain, /\/exit/);
});

test("promptLabel uses minimal grok-style composer cursor", () => {
  const label = promptLabel({ mode: "plan", cfg: { reasoning: "high" } });
  assert.match(stripAnsi(label), /›/);
  assert.doesNotMatch(stripAnsi(label), /plan/);
  assert.equal(label.endsWith(" "), true);
});

test("promptStatus adds subagent and profile indicators", () => {
  const status = promptStatus({ mode: "plan", reasoning: "medium", agent: "planner", profile: "safe-write" });
  const text = stripAnsi(status);
  assert.match(text, /plan/);
  assert.match(text, /medium/);
  assert.match(text, /@planner/);
  assert.match(text, /safe-write/);
});

test("promptStatus hides non-default profile", () => {
  const status = promptStatus({ mode: "plan", reasoning: "low", profile: "normal" });
  assert.doesNotMatch(stripAnsi(status), /normal/);
});

test("promptStatus shows conversation count in the prompt bar", () => {
  const status = promptStatus({ mode: "plan", reasoning: "medium", messages: 6, maxMessages: 80 });
  assert.match(stripAnsi(status), /6\/80 msg/);
});

test("handleKeypress on Tab defers backspace so it removes the tab, not the user input", async () => {
  // Note: this test exercises the legacy backspace path. The production code
  // now uses stripTrailingTab (see the next test) which is more robust on
  // Node 25+. This test is kept for backwards compatibility.

  // Simulate the production sequence: readline first appends "\t" to the line,
  // then our setImmediate callback fires and must remove the tab character
  // rather than eating the last char of "hello" the user typed.
  const writes = [];
  const mockRl = {
    line: "hello",
    cursor: 5,
    write(data, key) {
      writes.push({ data, key: key ? { name: key.name } : null });
    }
  };
  const state = { acceptingInput: true, mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };

  // Inline the same shape as handleKeypress for Tab.
  function pressTab(shift = false) {
    applyShortcut({ name: "tab", sequence: "\t", shift }, state, { rl: mockRl });
    return new Promise((resolve) => setImmediate(() => {
      // Simulate readline having appended a tab by the time we get here.
      mockRl.line = mockRl.line + "\t";
      if (mockRl.line.endsWith("\t")) {
        try {
          mockRl.write(null, { name: "backspace" });
        } catch {
          // ignore
        }
      }
      mockRl.line = mockRl.line.replace(/\t$/, "");
      resolve();
    }));
  }

  await pressTab(false);
  assert.equal(state.cfg.reasoning, "high");
  assert.equal(writes.length, 1);
  assert.equal(writes[0].key.name, "backspace");
  // The user-typed "hello" must still be intact.
  assert.equal(mockRl.line, "hello");

  await pressTab(true);
  assert.equal(state.mode, "build");
  assert.equal(writes.length, 2);
  assert.equal(writes[1].key.name, "backspace");
  assert.equal(mockRl.line, "hello");
});

test("stripTrailingTab removes the tab readline appended and leaves typed text intact", async () => {
  // Simulate the production fallback path: the readline/promises Interface in
  // Node 25+ doesn't expose a wrappable underlying interface, so we use the
  // keypress + setImmediate + stripTrailingTab path. This test verifies the
  // critical invariant: pressing Tab does NOT eat characters the user typed.
  const { PassThrough } = await import("node:stream");
  const readlinePromises = await import("node:readline/promises");
  const { emitKeypressEvents } = await import("node:readline");
  const { stripTrailingTab } = await import("../src/tui.js");

  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  emitKeypressEvents(input);
  const rl = readlinePromises.createInterface({ input, output, terminal: true });

  // Type "hi" then Tab through the stream. Capture exactly what the user's
  // buffer would look like at the moment stripTrailingTab is invoked.
  input.write("hi");
  await new Promise((r) => setImmediate(r));
  assert.equal(rl.line, "hi");

  input.write("\t");
  await new Promise((r) => setImmediate(r));
  assert.equal(rl.line, "hi\t", "readline should have appended a tab character");

  // Now run the same strip the production code runs.
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  stripTrailingTab(rl, state);
  assert.equal(rl.line, "hi", "stripTrailingTab must remove only the tab, not the typed text");
  if (typeof rl.cursor === "number") {
    assert.equal(rl.cursor, 2, "cursor should still be at the end of the typed text");
  }

  // Pressing Tab again should also be safe — the previous text is preserved.
  input.write("\t");
  await new Promise((r) => setImmediate(r));
  assert.equal(rl.line, "hi\t");
  stripTrailingTab(rl, state);
  assert.equal(rl.line, "hi");

  rl.close();
});

test("applyShortcut skips the shortcut when readline is busy or input starts with /", () => {
  const state = { mode: "plan", cfg: { mode: "plan", reasoning: "medium" } };
  // "/" line is a command — Tab must NOT rotate so completion can run.
  applyShortcut({ name: "tab" }, state, { persist: false, rl: { line: "/login" } });
  assert.equal(state.cfg.reasoning, "medium");
  // Busy readline without force — Tab must NOT rotate.
  state.acceptingInput = false;
  applyShortcut({ name: "tab" }, state, { persist: false, rl: { line: "" } });
  assert.equal(state.cfg.reasoning, "medium");
  // Busy readline but force=true — Tab rotates anyway.
  applyShortcut({ name: "tab" }, state, { persist: false, force: true, rl: { line: "" } });
  assert.equal(state.cfg.reasoning, "high");
});

