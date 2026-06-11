import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import { readComposerLine, readMultilinePrompt } from "../src/composer-input.js";

test("readComposerLine resolves typed input and clears bottom pane", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 100;
  emitKeypressEvents(input);

  const writes = [];
  const originalWrite = output.write.bind(output);
  output.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };

  let promptOffset = 0;
  const renderPane = ({ line, cursor, layout }) => {
    renderPane.promptOffset = 1;
    renderPane.promptColumn = () => 2 + cursor;
    return 2;
  };

  const pending = readComposerLine({
    input,
    output,
    renderPane,
    initialRows: 4
  });

  input.write("hi");
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\r");
  const line = await pending;

  assert.equal(line, "hi");
  assert.match(writes.join(""), /\x1b\[1;\d+r/);
  assert.match(writes.join(""), /\x1b\[r/);
});

test("readComposerLine supports multiline input with shift+enter", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 100;
  emitKeypressEvents(input);

  const renderPane = () => {
    renderPane.promptOffset = 1;
    renderPane.promptColumn = () => 2;
    return 3;
  };

  const pending = readComposerLine({
    input,
    output,
    renderPane,
    initialRows: 5
  });

  for (const ch of "line1") {
    input.emit("keypress", ch, { name: ch, shift: false, ctrl: false, meta: false });
  }
  input.emit("keypress", null, { name: "return", shift: true });
  await new Promise((resolve) => setImmediate(resolve));
  for (const ch of "line2") {
    input.emit("keypress", ch, { name: ch, shift: false, ctrl: false, meta: false });
  }
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", null, { name: "return", shift: false });
  const line = await pending;
  assert.equal(line, "line1\nline2");
});

test("readMultilinePrompt supports shift+enter newlines and enter submit", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => {};
  emitKeypressEvents(input);

  const pending = readMultilinePrompt({ input, output, banner: "task:" });

  for (const ch of "line1") {
    input.emit("keypress", ch, { name: ch, shift: false, ctrl: false, meta: false });
  }
  input.emit("keypress", null, { name: "return", shift: true });
  await new Promise((resolve) => setImmediate(resolve));
  for (const ch of "line2") {
    input.emit("keypress", ch, { name: ch, shift: false, ctrl: false, meta: false });
  }
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", null, { name: "return", shift: false });
  const line = await pending;
  assert.equal(line, "line1\nline2");
});

test("readComposerLine resolves slash selection with arrow keys", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.isTTY = true;
  output.rows = 24;
  output.columns = 100;
  emitKeypressEvents(input);

  const items = [["/status", "status"], ["/session", "session"]];
  const renderPane = ({ layout }) => {
    renderPane.promptOffset = 1;
    renderPane.promptColumn = () => 2;
    return 2;
  };

  const pending = readComposerLine({
    input,
    output,
    renderPane,
    getPaletteItems: (line) => (line.startsWith("/") ? items : []),
    resolveSlashSubmit: (line, palette, selection) => palette[selection]?.[0] || line,
    initialRows: 4
  });

  input.write("/");
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\u001b[B");
  await new Promise((resolve) => setImmediate(resolve));
  input.write("\r");
  const line = await pending;
  assert.equal(line, "/session");
});