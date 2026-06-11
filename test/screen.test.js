import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import {
  applyLineCompletion,
  fitTerminalWidth,
  longestCommonPrefix,
  maxBottomPaneRows,
  releaseBottomPane,
  reserveBottomPane,
  resizeBottomPane,
  writeAtRow
} from "../src/screen.js";

test("longestCommonPrefix finds shared command prefix", () => {
  assert.equal(longestCommonPrefix(["/status", "/session", "/shell"]), "/s");
  assert.equal(longestCommonPrefix(["/help"]), "/help");
});

test("applyLineCompletion expands to a shared slash prefix", () => {
  const result = applyLineCompletion("/s", 2, ["/status", "/session"]);
  assert.equal(result.line, "/s");
  assert.equal(result.cursor, 2);
  const single = applyLineCompletion("/stat", 5, ["/status"]);
  assert.equal(single.line, "/status");
  assert.equal(single.cursor, 7);
});

test("fitTerminalWidth uses the full terminal width minus padding", () => {
  const stream = new PassThrough();
  stream.columns = 140;
  assert.equal(fitTerminalWidth(stream, 2), 138);
});

test("maxBottomPaneRows leaves room for transcript output", () => {
  const stream = new PassThrough();
  stream.rows = 24;
  assert.equal(maxBottomPaneRows(stream), 19);
});

test("reserveBottomPane sets scroll region and start row", () => {
  const stream = new PassThrough();
  stream.rows = 24;
  stream.columns = 100;
  const writes = [];
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  const layout = reserveBottomPane(8, stream);
  assert.equal(layout.startRow, 16);
  assert.equal(layout.bottomRows, 8);
  assert.match(writes.join(""), /\x1b\[1;16r/);
  writeAtRow(layout.startRow, "composer", stream);
  assert.match(writes.join(""), /\x1b\[17;1H/);
});

test("resizeBottomPane grows composer without parking transcript cursor", () => {
  const stream = new PassThrough();
  stream.rows = 24;
  stream.columns = 100;
  const writes = [];
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  const layout = reserveBottomPane(6, stream);
  const grown = resizeBottomPane(layout, 8, stream);
  assert.equal(grown.bottomRows, 8);
  assert.equal(grown.startRow, 16);
  const joined = writes.join("");
  assert.match(joined, /\x1b\[1;16r/);
  assert.doesNotMatch(joined, /\x1b\[16;1H/);
});

test("releaseBottomPane resets scroll region and parks cursor above the composer", () => {
  const stream = new PassThrough();
  stream.rows = 24;
  stream.columns = 100;
  const writes = [];
  const originalWrite = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => {
    writes.push(String(chunk));
    return originalWrite(chunk, ...rest);
  };
  const layout = reserveBottomPane(8, stream);
  releaseBottomPane(layout, stream);
  assert.match(writes.join(""), /\x1b\[r/);
  assert.match(writes.join(""), /\x1b\[16;1H/);
  assert.match(writes.join(""), /\n/);
});