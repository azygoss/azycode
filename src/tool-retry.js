import { createToolResult, TOOL_RESULT_CODES } from "./tool-result.js";

export const DEFAULT_TOOL_RETRY_POLICY = {
  maxIdenticalFailures: 3,
  retryTransientReads: true,
  transientReadTools: new Set(["read_file", "read_many_files", "file_info", "search", "list_files"]),
  maxTransientRetries: 1,
  transientErrorCodes: new Set([TOOL_RESULT_CODES.error, TOOL_RESULT_CODES.partial_error])
};

export function failureKey(tool, args) {
  return `${tool}:${JSON.stringify(args ?? {})}`;
}

export function shouldRetryTransient({ tool, code, attempt, policy = DEFAULT_TOOL_RETRY_POLICY }) {
  if (!policy.retryTransientReads) return false;
  if (!policy.transientReadTools.has(tool)) return false;
  if (!policy.transientErrorCodes.has(code)) return false;
  return attempt < policy.maxTransientRetries;
}

export function applyDuplicateFailurePolicy(result, { tool, args, failures, policy = DEFAULT_TOOL_RETRY_POLICY }) {
  if (result.ok) {
    failures.delete(failureKey(tool, args));
    return result;
  }
  const key = failureKey(tool, args);
  const count = (failures.get(key) || 0) + 1;
  failures.set(key, count);
  if (count < policy.maxIdenticalFailures) return result;
  return createToolResult({
    ok: false,
    code: TOOL_RESULT_CODES.duplicate_failure,
    text: result.text,
    metadata: {
      ...result.metadata,
      failureCount: count,
      suggestion: "This identical tool call has failed repeatedly. Change approach, arguments, or tools."
    },
    truncated: result.truncated
  });
}

export function resolveToolRetryPolicy(cfg = {}) {
  const custom = cfg.toolRetry || {};
  return {
    ...DEFAULT_TOOL_RETRY_POLICY,
    maxIdenticalFailures: Number.isFinite(Number(custom.maxIdenticalFailures))
      ? Math.max(1, Number(custom.maxIdenticalFailures))
      : DEFAULT_TOOL_RETRY_POLICY.maxIdenticalFailures,
    retryTransientReads: custom.retryTransientReads !== false,
    maxTransientRetries: Number.isFinite(Number(custom.maxTransientRetries))
      ? Math.max(0, Number(custom.maxTransientRetries))
      : DEFAULT_TOOL_RETRY_POLICY.maxTransientRetries
  };
}