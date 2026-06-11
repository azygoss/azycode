import test from "node:test";
import assert from "node:assert/strict";
import { createToolResult, TOOL_RESULT_CODES } from "../src/tool-result.js";
import {
  applyDuplicateFailurePolicy,
  failureKey,
  resolveToolRetryPolicy,
  shouldRetryTransient
} from "../src/tool-retry.js";

test("shouldRetryTransient retries read errors once", () => {
  const policy = resolveToolRetryPolicy({});
  assert.equal(shouldRetryTransient({ tool: "read_file", code: TOOL_RESULT_CODES.error, attempt: 0, policy }), true);
  assert.equal(shouldRetryTransient({ tool: "read_file", code: TOOL_RESULT_CODES.error, attempt: 1, policy }), false);
  assert.equal(shouldRetryTransient({ tool: "shell", code: TOOL_RESULT_CODES.error, attempt: 0, policy }), false);
});

test("applyDuplicateFailurePolicy escalates repeated identical failures", () => {
  const failures = new Map();
  const policy = resolveToolRetryPolicy({ toolRetry: { maxIdenticalFailures: 2 } });
  const args = { file: "missing.js" };
  const base = createToolResult({ ok: false, code: TOOL_RESULT_CODES.error, text: "Tool read_file failed: ENOENT" });

  applyDuplicateFailurePolicy(base, { tool: "read_file", args, failures, policy });
  const second = applyDuplicateFailurePolicy(base, { tool: "read_file", args, failures, policy });
  assert.equal(second.code, TOOL_RESULT_CODES.duplicate_failure);
  assert.match(second.metadata.suggestion, /failed repeatedly/);
  assert.equal(failureKey("read_file", args), 'read_file:{"file":"missing.js"}');
});