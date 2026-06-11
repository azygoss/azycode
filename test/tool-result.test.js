import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyToolResultFromText,
  createToolResult,
  formatToolResultForModel,
  normalizeToolResult,
  TOOL_RESULT_CODES
} from "../src/tool-result.js";

test("normalizeToolResult preserves structured tool payloads", () => {
  const result = normalizeToolResult("read_file", createToolResult({
    ok: true,
    code: TOOL_RESULT_CODES.ok,
    text: "file contents",
    metadata: { path: "src/a.js" }
  }));
  assert.equal(result.ok, true);
  assert.equal(result.code, "ok");
  assert.equal(result.metadata.path, "src/a.js");
});

test("classifyToolResultFromText maps common failure strings", () => {
  assert.equal(classifyToolResultFromText("shell", "exit code: 1").code, TOOL_RESULT_CODES.error);
  assert.equal(classifyToolResultFromText("read_file", "Tool read_file failed: ENOENT").code, TOOL_RESULT_CODES.error);
  assert.equal(classifyToolResultFromText("write_file", "Tool call rejected by user.").code, TOOL_RESULT_CODES.rejected);
});

test("formatToolResultForModel appends suggestions and retry notes", () => {
  const text = formatToolResultForModel(createToolResult({
    ok: false,
    code: TOOL_RESULT_CODES.duplicate_failure,
    text: "Tool read_file failed: missing",
    metadata: { suggestion: "Try another path.", retries: 1 }
  }));
  assert.match(text, /Suggestion: Try another path/);
  assert.match(text, /retried 1 time/);
});