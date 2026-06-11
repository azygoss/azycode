import fs from "node:fs";
import path from "node:path";
import { LlmClient, assistantMessageFromCompletion } from "./llm.js";
import { createTools } from "./tools.js";
import { id, loadState, resolveAgentMaxSteps, updateState } from "./config.js";
import { AgentCancelledError, AgentStepLimitError } from "./agent-errors.js";
import { searchMemory } from "./memory.js";
import { contextPack, formatContextPack } from "./context.js";
import { extractToolPreview, READ_ONLY_TOOLS, summarizeToolArgs } from "./harness.js";
import { trimConversation } from "./conversation.js";
import { createModeRuntime } from "./agent-runtime.js";
import { formatActiveTodos } from "./todos.js";
import { getSkillText } from "./skills.js";

import { discoverProjectInstructions } from "./instructions.js";
import { createMcpTools } from "./mcp.js";
import { runHooks, loadHookConfig } from "./hooks.js";
import { compactConversationDeterministic, compactConversationWithModel } from "./compaction.js";
import { appendOpenTodosNotice } from "./agent-report.js";
import { formatToolResultForModel, normalizeToolResult } from "./tool-result.js";
import { applyDuplicateFailurePolicy, resolveToolRetryPolicy, shouldRetryTransient } from "./tool-retry.js";
import { formatSubagentResults, runSubagentsParallel } from "./subagents.js";
import { mergeAbortSignals } from "./exec.js";
import { debug, warn, error as logError } from "./logger.js";
import { systemForMode } from "./prompts.js";

export { systemForMode };

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const MAX_SESSIONS = 50;
const MAX_IN_RUN_MESSAGES = 80;

export async function runAgent({
  cfg,
  cwd,
  prompt,
  mode = cfg.mode,
  subagent = null,
  maxSteps,
  returnSession = false,
  onEvent = null,
  includeContext = false,
  conversation = [],
  confirmTool = null,
  onModeChange = null,
  skills = [],
  progressStyle = "tui",
  signal = null,
  stream = null,
  onToken = null,
  subagentDepth = 0
} = {}) {
  const stepLimit = resolveAgentMaxSteps(cfg, maxSteps);
  const client = new LlmClient(cfg);
  const activeModel = subagent?.model || client.provider.model;
  const modeRuntime = createModeRuntime(mode, { cfg, onModeChange });
  const resolveCfg = () => {
    const activeMode = modeRuntime.getMode();
    return activeMode === "always-approve" ? { ...cfg, alwaysApprove: true } : cfg;
  };
  debug(`Agent start mode=${mode} model=${activeModel} stepLimit=${stepLimit ?? "unlimited"}`);

  const projectRules = discoverProjectInstructions(cwd);
  const useStream = stream ?? Boolean(cfg.streamResponses);
  const relevantMemory = loadRelevantMemory(prompt);
  const contextPackStr = includeContext ? await loadContextPack(cwd) : "";
  if (includeContext) debug(`Context pack loaded: ${contextPackStr.length} chars`);
  const sessionId = id("ses");
  let activeTodos = formatActiveTodos(cwd, { sessionId });

  const buildSystemContent = () => [
    subagent?.system || systemForMode(modeRuntime.getMode(), { cwd, cfg, stepLimit }),
    getSkillText(cfg, skills, { cwd, prompt }),
    projectRules,
    relevantMemory,
    activeTodos,
    contextPackStr
  ].filter(Boolean).join("\n\n");

  const messages = [
    { role: "system", content: buildSystemContent() },
    ...conversation.filter((message) => message.role !== "system"),
    { role: "user", content: prompt }
  ];
  const events = [];
  const runStartedAt = Date.now();
  let lastStep = 0;

  const emit = (event) => {
    const enriched = { ...event, sessionId, at: new Date().toISOString() };
    events.push(enriched);
    if (onEvent) onEvent(enriched);
  };

  const hooks = loadHookConfig(cfg, cwd);
  const maxSubagentDepth = Number.isFinite(Number(cfg.maxSubagentDepth))
    ? Math.max(0, Math.floor(Number(cfg.maxSubagentDepth)))
    : 2;
  const subagentSpawner = async (tasks, runOptions = {}) => {
    if (subagentDepth >= maxSubagentDepth) {
      return formatSubagentResults((Array.isArray(tasks) ? tasks : []).map((task, index) => ({
        index: index + 1,
        agent: task?.agent,
        ok: false,
        error: `Subagent nesting depth limit (${maxSubagentDepth}) reached.`
      })));
    }
    const results = await runSubagentsParallel({
      cfg,
      cwd,
      tasks,
      signal: runOptions.signal || signal,
      maxParallel: cfg.maxParallelSubagents || 4,
      maxStepsPerAgent: cfg.subagentMaxSteps || 8,
      subagentDepth: subagentDepth + 1,
      onSubagentEvent: (event) => emit({ ...event, step: lastStep, maxSteps: stepLimit })
    });
    return formatSubagentResults(results);
  };
  const builtinTools = createTools({
    cwd,
    resolveCfg,
    confirmTool,
    modeRuntime,
    subagentSpawner,
    onApproval: (event) => emit({ ...event, step: lastStep, maxSteps: stepLimit, summary: summarizeToolArgs(event.tool, event.args) })
  });
  let mcp = { tools: [], close: async () => {} };
  try {
    mcp = await createMcpTools(cfg);
  } catch (error) {
    warn(`MCP tools unavailable: ${error.message}`);
  }
  const tools = [...builtinTools, ...mcp.tools];
  const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

  const pendingToolRuns = [];
  let pendingSession = null;
  let sessionRecorded = false;
  let stoppedReason = null;
  const recentFailures = new Map();
  const toolRetryPolicy = resolveToolRetryPolicy(cfg);

  function recordToolRun(run) {
    pendingToolRuns.push({
      ...run,
      at: new Date().toISOString(),
      content: String(run.content).slice(0, 2000),
      code: run.code || (run.ok ? "ok" : "error"),
      metadata: run.metadata || {}
    });
  }

  function recordSession(sessionId, session) {
    pendingSession = { sessionId, session: { ...session, createdAt: new Date().toISOString() } };
    sessionRecorded = true;
  }

  function trimPersistedSessions(state) {
    const entries = Object.entries(state.sessions || {});
    if (entries.length <= MAX_SESSIONS) return;
    entries.sort((a, b) => String(b[1]?.createdAt || "").localeCompare(String(a[1]?.createdAt || "")));
    state.sessions = Object.fromEntries(entries.slice(0, MAX_SESSIONS));
  }

  function flushState() {
    if (!pendingToolRuns.length && !pendingSession) return;
    const toolBatch = pendingToolRuns.splice(0, pendingToolRuns.length);
    const sessionBatch = pendingSession;
    pendingSession = null;
    try {
      updateState((state) => {
        if (sessionBatch) {
          state.sessions[sessionBatch.sessionId] = sessionBatch.session;
          trimPersistedSessions(state);
        }
        if (toolBatch.length) {
          state.toolRuns.push(...toolBatch);
          state.toolRuns = state.toolRuns.slice(-500);
        }
        return state;
      });
    } catch (error) {
      if (toolBatch.length) pendingToolRuns.unshift(...toolBatch);
      if (sessionBatch) pendingSession = sessionBatch;
      logError(`Failed to persist agent state: ${error.message}`);
      emit({ type: "agent_error", step: lastStep, error: `state persistence failed: ${error.message}` });
    }
  }

  function assertNotCancelled(activeSignal = signal) {
    if (activeSignal?.aborted || signal?.aborted) {
      throw new AgentCancelledError({ events, style: progressStyle });
    }
  }

  function toolTimeoutMs() {
    const configured = Number(cfg.toolTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TOOL_TIMEOUT_MS;
  }

  async function runSingleToolCall(call, step, batchSignal = null) {
    const activeSignal = mergeAbortSignals([signal, batchSignal]);
    const name = call.function?.name;
    const rawArgs = call.function?.arguments || "{}";
    const parsed = parseToolArgs(rawArgs);
    const summary = summarizeToolArgs(name, parsed.ok ? parsed.value : {});

    if (!parsed.ok) {
      emit({ type: "tool_start", step, maxSteps: stepLimit, tool: name, summary });
      const startedAt = Date.now();
      const content = `Tool arguments were invalid JSON: ${parsed.error}`;
      const durationMs = Date.now() - startedAt;
      emit({
        type: "tool_end",
        step,
        maxSteps: stepLimit,
        tool: name,
        ok: false,
        code: "invalid_args",
        durationMs,
        summary,
        args: parsed.ok ? parsed.value : {},
        errorPreview: parsed.error
      });
      recordToolRun({ sessionId, step, name, ok: false, durationMs, args: { raw: rawArgs }, content });
      return {
        role: "tool",
        tool_call_id: call.id,
        name,
        content
      };
    }

    const args = parsed.value;
    let hookPayload = { tool: name, args, step, sessionId, cwd };
    try {
      hookPayload = await runHooks("pre_tool", hookPayload, hooks, { cwd, signal: activeSignal });
    } catch (error) {
      const content = `Tool ${name} blocked by hook: ${error.message}`;
      emit({ type: "tool_start", step, maxSteps: stepLimit, tool: name, summary });
      emit({
        type: "tool_end",
        step,
        maxSteps: stepLimit,
        tool: name,
        ok: false,
        code: "rejected",
        durationMs: 0,
        summary,
        args,
        errorPreview: error.message
      });
      recordToolRun({ sessionId, step, name, ok: false, durationMs: 0, args, content });
      return { role: "tool", tool_call_id: call.id, name, content };
    }
    const effectiveName = hookPayload.tool ?? name;
    const effectiveArgs = hookPayload.args ?? args;
    const effectiveSummary = summarizeToolArgs(effectiveName, effectiveArgs);
    const selected = toolMap[effectiveName];
    emit({ type: "tool_start", step, maxSteps: stepLimit, tool: effectiveName, summary: effectiveSummary });
    const startedAt = Date.now();
    let structured;
    let timer = null;
    const toolAbort = new AbortController();
    const onAgentAbort = () => toolAbort.abort();
    activeSignal?.addEventListener("abort", onAgentAbort, { once: true });
    let transientAttempt = 0;
    try {
      while (true) {
        let rawContent;
        timer = null;
        try {
          assertNotCancelled(activeSignal);
          const timeout = toolTimeoutMs();
          const runner = selected
            ? selected.run(effectiveArgs, { signal: mergeAbortSignals([toolAbort.signal, activeSignal]), sessionId })
            : Promise.resolve(`Unknown tool: ${effectiveName}`);
          rawContent = await Promise.race([
            runner,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                toolAbort.abort();
                reject(new Error(`Tool ${effectiveName} timed out after ${timeout}ms`));
              }, timeout);
            })
          ]);
        } catch (error) {
          if (activeSignal?.aborted || signal?.aborted || toolAbort.signal.aborted) {
            throw new AgentCancelledError({ events, style: progressStyle });
          }
          rawContent = error.message?.includes("timed out after")
            ? `Tool ${effectiveName} failed: ${error.message}`
            : `Tool ${effectiveName} failed: ${error.message}`;
          warn(`Tool ${effectiveName} failed at step ${step}: ${error.message}`);
        } finally {
          if (timer) clearTimeout(timer);
        }

        structured = normalizeToolResult(effectiveName, rawContent);
        if (shouldRetryTransient({
          tool: effectiveName,
          code: structured.code,
          attempt: transientAttempt,
          policy: toolRetryPolicy
        })) {
          transientAttempt += 1;
          structured.metadata = { ...structured.metadata, retries: transientAttempt };
          continue;
        }
        break;
      }
    } finally {
      activeSignal?.removeEventListener("abort", onAgentAbort);
      if (!toolAbort.signal.aborted) toolAbort.abort();
    }

    structured = applyDuplicateFailurePolicy(structured, {
      tool: effectiveName,
      args: effectiveArgs,
      failures: recentFailures,
      policy: toolRetryPolicy
    });
    const content = formatToolResultForModel(structured);
    const outcome = { ok: structured.ok, code: structured.code };
    const durationMs = Date.now() - startedAt;
    emit({
      type: "tool_end",
      step,
      maxSteps: stepLimit,
      tool: effectiveName,
      ok: outcome.ok,
      code: outcome.code,
      durationMs,
      summary: effectiveSummary,
      args: effectiveArgs,
      preview: outcome.ok ? extractToolPreview(effectiveName, effectiveArgs, content) : null,
      errorPreview: outcome.ok ? "" : String(content).slice(0, 120)
    });
    recordToolRun({
      sessionId,
      step,
      name: effectiveName,
      ok: outcome.ok,
      code: outcome.code,
      durationMs,
      args: effectiveArgs,
      content,
      metadata: structured.metadata
    });
    await runHooks("post_tool", {
      tool: effectiveName,
      args: effectiveArgs,
      ok: outcome.ok,
      code: outcome.code,
      content: String(content).slice(0, 2000),
      step,
      sessionId,
      cwd
    }, hooks, { cwd, signal: activeSignal }).catch((error) => warn(`post_tool hook failed: ${error.message}`));
    return {
      role: "tool",
      tool_call_id: call.id,
      name: effectiveName,
      content: String(content).slice(0, 120000)
    };
  }

  async function executeToolCalls(calls, step) {
    assertNotCancelled();
    const readOnly = [];
    const sequential = [];
    for (const call of calls) {
      const name = call.function?.name;
      if (READ_ONLY_TOOLS.has(name)) readOnly.push(call);
      else sequential.push(call);
    }

    if (readOnly.length > 1) {
      const batchAbort = new AbortController();
      const batchSignal = mergeAbortSignals([signal, batchAbort.signal]);
      try {
        const settled = await Promise.allSettled(readOnly.map(async (call) => {
          try {
            return await runSingleToolCall(call, step, batchSignal);
          } catch (error) {
            if (error instanceof AgentCancelledError) batchAbort.abort(error);
            throw error;
          }
        }));
        let cancelError = null;
        for (let i = 0; i < settled.length; i += 1) {
          const entry = settled[i];
          const call = readOnly[i];
          if (entry.status === "fulfilled") {
            messages.push(entry.value);
            continue;
          }
          if (entry.reason instanceof AgentCancelledError) {
            cancelError = cancelError || entry.reason;
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              name: call.function?.name,
              content: "Tool call cancelled."
            });
            continue;
          }
          throw entry.reason;
        }
        if (cancelError) throw cancelError;
      } finally {
        if (!batchAbort.signal.aborted) batchAbort.abort();
      }
    } else if (readOnly.length === 1) {
      messages.push(await runSingleToolCall(readOnly[0], step));
    }

    for (const call of sequential) {
      messages.push(await runSingleToolCall(call, step));
    }
    flushState();
  }

  async function maybeTrimMessages(step) {
    const maxMessages = Number(cfg.maxInRunMessages) || MAX_IN_RUN_MESSAGES;
    const nonSystem = messages.filter((message) => message.role !== "system");
    if (nonSystem.length <= maxMessages) return;
    const before = nonSystem.length;
    let trimmed;
    if (cfg.compaction === "llm") {
      try {
        trimmed = await compactConversationWithModel({
          client,
          messages: nonSystem,
          model: activeModel,
          keepRecent: Math.max(8, Math.floor(maxMessages * 0.4)),
          signal
        });
        emit({ type: "context_compact", step, maxSteps: stepLimit, before, after: trimmed.length, method: "llm" });
      } catch (error) {
        warn(`LLM compaction failed, falling back to trim: ${error.message}`);
        trimmed = trimConversation(nonSystem, maxMessages);
        emit({ type: "context_trim", step, maxSteps: stepLimit, before, after: trimmed.length });
      }
    } else if (cfg.compaction === "deterministic") {
      trimmed = compactConversationDeterministic(nonSystem, {
        keepRecent: Math.max(8, Math.floor(maxMessages * 0.4)),
        todoState: formatActiveTodos(cwd, { sessionId })
      });
      emit({ type: "context_compact", step, maxSteps: stepLimit, before, after: trimmed.length, method: "deterministic" });
    } else {
      trimmed = trimConversation(nonSystem, maxMessages);
      emit({ type: "context_trim", step, maxSteps: stepLimit, before, after: trimmed.length });
    }
    messages.length = 0;
    messages.push({ role: "system", content: buildSystemContent() }, ...trimmed);
  }

  async function runModelTurn(step) {
    assertNotCancelled();
    lastStep = step;
    if (stepLimit && step >= stepLimit - 1) {
      emit({ type: "step_budget_low", step, maxSteps: stepLimit, remaining: Math.max(0, stepLimit - step + 1) });
    }
    const activeMode = modeRuntime.getMode();
    let modelPayload = { step, mode: activeMode, model: activeModel, sessionId, cwd };
    try {
      modelPayload = await runHooks("pre_model", modelPayload, hooks, { cwd, signal });
    } catch (error) {
      if (error.code === "hook_blocked") throw error;
      warn(`pre_model hook failed: ${error.message}`);
    }
    const turnModel = modelPayload.model ?? activeModel;
    const turnMode = modelPayload.mode ?? activeMode;
    emit({ type: "model_start", step, maxSteps: stepLimit, model: turnModel, mode: turnMode });
    const startedAt = Date.now();
    let streamedText = "";
    const completion = await client.chat({
      messages,
      tools,
      model: turnModel,
      reasoning: subagent?.reasoning || cfg.reasoning,
      signal,
      stream: useStream,
      onDelta: useStream
        ? (delta) => {
          if (delta.content) {
            streamedText += delta.content;
            const tokenEvent = { type: "model_token", step, maxSteps: stepLimit, delta: delta.content, text: streamedText };
            emit(tokenEvent);
            onToken?.(tokenEvent);
          }
        }
        : null
    });
    const durationMs = Date.now() - startedAt;
    const message = assistantMessageFromCompletion(completion);
    if (!message) {
      logError(`Provider returned no assistant message at step ${step}`);
      const providerError = new Error("Provider returned no assistant message.");
      providerError.code = "provider_empty_message";
      throw providerError;
    }
    messages.push(message);
    const calls = message.tool_calls || [];
    emit({
      type: "model_end",
      step,
      maxSteps: stepLimit,
      toolCalls: calls.length,
      tools: calls.map((call) => call.function?.name).filter(Boolean),
      durationMs,
      usage: completion?.usage || null
    });
    let postPayload = {
      step,
      toolCalls: calls.length,
      durationMs,
      usage: completion?.usage || null,
      sessionId,
      cwd,
      tools: calls.map((call) => call.function?.name).filter(Boolean)
    };
    try {
      postPayload = await runHooks("post_model", postPayload, hooks, { cwd, signal });
    } catch (error) {
      if (error.code === "hook_blocked") throw error;
      warn(`post_model hook failed: ${error.message}`);
    }
    const skipTools = new Set(Array.isArray(postPayload.skipTools) ? postPayload.skipTools : []);
    const effectiveCalls = skipTools.size
      ? calls.filter((call) => !skipTools.has(call.function?.name))
      : calls;
    return { message, calls: effectiveCalls };
  }

  function finishRun(content, step, status = "ok") {
    const finalContent = appendOpenTodosNotice(content, cwd);
    stoppedReason = status;
    emit({ type: "final", step, maxSteps: stepLimit });
    emit({ type: "agent_run_end", step, maxSteps: stepLimit, status, durationMs: Date.now() - runStartedAt });
    recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events, stopped: status });
    flushState();
    return returnSession ? { content: finalContent, sessionId, messages, events } : finalContent;
  }

  debug(`Agent run start: mode=${modeRuntime.getMode()} model=${activeModel} steps=${stepLimit ?? "unlimited"}`);
  emit({ type: "agent_run_start", step: 0, maxSteps: stepLimit, mode: modeRuntime.getMode(), model: activeModel });
  try {
    await runHooks("agent_run_start", { prompt, mode: modeRuntime.getMode(), model: activeModel, sessionId, cwd }, hooks, { cwd, signal });
  } catch (error) {
    if (error.code === "hook_blocked") {
      const message = error.message || "Agent run blocked by hook";
      emit({ type: "agent_run_end", step: 0, maxSteps: stepLimit, status: "blocked", durationMs: Date.now() - runStartedAt });
      recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events, stopped: "blocked" });
      flushState();
      if (returnSession) return { content: message, sessionId, messages, events };
      return message;
    }
    warn(`agent_run_start hook failed: ${error.message}`);
  }

  try {
    for (let step = 1; stepLimit === null || step <= stepLimit; step += 1) {
      const { message, calls } = await runModelTurn(step);
      if (!calls.length) {
        return finishRun(message.content || "", step);
      }

      await executeToolCalls(calls, step);
      await maybeTrimMessages(step);

      const hadTodo = calls.some((call) => call.function?.name === "todo");
      const modeChange = modeRuntime.consumeModeChange();
      if (modeChange || hadTodo) {
        if (hadTodo) activeTodos = formatActiveTodos(cwd, { sessionId });
        messages[0] = { role: "system", content: buildSystemContent() };
        if (modeChange) {
          emit({
            type: "mode_change",
            step,
            mode: modeChange.mode,
            previous: modeChange.previous,
            reason: modeChange.reason || ""
          });
        }
      }
    }

    if (stepLimit != null) {
      let bonusStep = stepLimit + 1;
      while (messages[messages.length - 1]?.role === "tool" && bonusStep <= stepLimit + 2) {
        const { message, calls } = await runModelTurn(bonusStep);
        if (!calls.length) {
          return finishRun(message.content || "", bonusStep);
        }
        for (const call of calls) {
          const name = call.function?.name || "tool";
          const content = "Step budget exhausted. Provide your final answer as assistant text without requesting more tools.";
          emit({ type: "tool_start", step: bonusStep, maxSteps: stepLimit, tool: name, summary: summarizeToolArgs(name, {}) });
          emit({ type: "tool_end", step: bonusStep, maxSteps: stepLimit, tool: name, ok: false, code: "rejected", durationMs: 0, summary: "budget exhausted" });
          messages.push({ role: "tool", tool_call_id: call.id, name, content });
        }
        flushState();
        bonusStep += 1;
      }
    }

    const partialContent = lastAssistantContent(messages);
    warn(`Agent step limit reached: ${stepLimit} steps without a final answer`);
    emit({ type: "step_limit", step: stepLimit, maxSteps: stepLimit, stoppedAtStep: lastStep });
    emit({ type: "agent_run_end", step: lastStep, maxSteps: stepLimit, status: "step_limit", durationMs: Date.now() - runStartedAt });
    stoppedReason = "step_limit";
    recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events, stopped: "step_limit" });
    flushState();
    throw new AgentStepLimitError({ maxSteps: stepLimit, events, partialContent, style: progressStyle, cwd });
  } catch (error) {
    if (!(error instanceof AgentStepLimitError)) {
      const cancelled = error instanceof AgentCancelledError || signal?.aborted;
      stoppedReason = cancelled ? "cancelled" : "error";
      if (!events.some((event) => event.type === "agent_error" && event.error === error.message)) {
        emit({ type: "agent_error", step: lastStep, error: error.message });
      }
      if (!events.some((event) => event.type === "agent_run_end")) {
        emit({
          type: "agent_run_end",
          step: lastStep,
          maxSteps: stepLimit,
          status: stoppedReason,
          durationMs: Date.now() - runStartedAt
        });
      }
    }
    throw error;
  } finally {
    await runHooks("agent_run_end", {
      sessionId,
      stopped: stoppedReason || "error",
      cwd,
      prompt
    }, hooks, { cwd, signal }).catch(() => {});
    await mcp.close().catch(() => {});
    if (!sessionRecorded) {
      recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events, stopped: stoppedReason || "error" });
    }
    flushState();
  }
}

function lastAssistantContent(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && String(message.content || "").trim()) {
      return String(message.content).trim();
    }
  }
  return "";
}

function parseToolArgs(rawArgs) {
  try {
    return { ok: true, value: JSON.parse(rawArgs || "{}") };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function loadRelevantMemory(prompt) {
  const notes = searchMemory(prompt).slice(0, 8);
  if (!notes.length) return "";
  return `User memory:\n${notes.map((note) => `- ${note.text}`).join("\n")}`;
}

async function loadContextPack(cwd) {
  const pack = await contextPack(cwd, { maxFiles: 30, maxBytes: 60000 });
  return formatContextPack(pack);
}