export const TOOL_RESULT_CODES = {
  ok: "ok",
  error: "error",
  rejected: "rejected",
  timeout: "timeout",
  cancelled: "cancelled",
  invalid_args: "invalid_args",
  unknown_tool: "unknown_tool",
  partial_error: "partial_error",
  budget_exhausted: "budget_exhausted",
  duplicate_failure: "duplicate_failure"
};

export function createToolResult({ ok, code, text, metadata = {}, truncated = false }) {
  return {
    ok: Boolean(ok),
    code: String(code || (ok ? TOOL_RESULT_CODES.ok : TOOL_RESULT_CODES.error)),
    text: String(text ?? ""),
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    truncated: Boolean(truncated)
  };
}

export function classifyToolResultFromText(name, content) {
  const text = String(content ?? "");
  if (text.startsWith("Unknown tool:")) return { ok: false, code: TOOL_RESULT_CODES.unknown_tool };
  if (text === "Tool call rejected by user.") return { ok: false, code: TOOL_RESULT_CODES.rejected };
  if (text.startsWith(`Tool ${name} blocked by hook:`)) return { ok: false, code: TOOL_RESULT_CODES.rejected };
  if (text.startsWith("Tool arguments were invalid JSON:")) return { ok: false, code: TOOL_RESULT_CODES.invalid_args };
  if (text.startsWith(`Tool ${name} failed:`) && /timed out after/.test(text)) return { ok: false, code: TOOL_RESULT_CODES.timeout };
  if (text.startsWith(`Tool ${name} failed:`) && /Aborted/i.test(text)) return { ok: false, code: TOOL_RESULT_CODES.cancelled };
  if (text.startsWith(`Tool ${name} failed:`)) return { ok: false, code: TOOL_RESULT_CODES.error };
  if (name === "read_many_files" && /\nERROR:/.test(text)) return { ok: false, code: TOOL_RESULT_CODES.partial_error };
  if (text.startsWith("exit code:")) return { ok: false, code: TOOL_RESULT_CODES.error };
  if (text.startsWith("Step budget exhausted.")) return { ok: false, code: TOOL_RESULT_CODES.budget_exhausted };
  return { ok: true, code: TOOL_RESULT_CODES.ok };
}

export function normalizeToolResult(name, value) {
  if (value && typeof value === "object" && "text" in value) {
    const classified = classifyToolResultFromText(name, value.text);
    return createToolResult({
      ok: value.ok ?? classified.ok,
      code: value.code || classified.code,
      text: value.text,
      metadata: value.metadata || {},
      truncated: value.truncated
    });
  }
  const text = String(value ?? "");
  const classified = classifyToolResultFromText(name, text);
  return createToolResult({
    ok: classified.ok,
    code: classified.code,
    text,
    metadata: {},
    truncated: text.length >= 120000
  });
}

export function formatToolResultForModel(result) {
  let out = String(result.text || "");
  if (result.truncated) out += "\n[output truncated]";
  if (result.metadata?.suggestion) out += `\n\nSuggestion: ${result.metadata.suggestion}`;
  if (result.metadata?.retries) out += `\n[retried ${result.metadata.retries} time(s)]`;
  return out.slice(0, 120000);
}