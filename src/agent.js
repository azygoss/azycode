import fs from "node:fs";
import path from "node:path";
import { LlmClient, assistantMessageFromCompletion } from "./llm.js";
import { createTools } from "./tools.js";
import { id, loadState, resolveAgentMaxSteps, saveState } from "./config.js";
import { AgentStepLimitError } from "./agent-errors.js";
import { searchMemory } from "./memory.js";
import { contextPack, formatContextPack } from "./context.js";
import { summarizeToolArgs } from "./harness.js";
import { createModeRuntime } from "./agent-runtime.js";
import { formatActiveTodos } from "./todos.js";

export function systemForMode(mode) {
  const base = [
    "You are Azycode, an AI coding harness running inside the user's local repository.",
    "Operate like a senior coding agent: inspect current files before changing them, keep edits scoped, and verify behavior with the most relevant available checks.",
    "Use bounded tools deliberately: prefer search/list/file_info before broad reads, use read_file line ranges for large files, and use search maxResults/contextLines to keep context small.",
    "Use the todo tool to track multi-step work. Use set_mode when the task phase changes: switch to plan before large or risky changes, then switch back to always-approve or goal to implement.",
    "Do not claim a file changed unless a write/edit/copy/move/delete/apply_patch/shell tool actually changed it.",
    "Respect tool policy and git guard when enabled. If writes or shell are blocked on a protected branch, use git_checkout with create:true to switch branches, then continue.",
    "When editing, preserve existing style and avoid unrelated refactors. When reviewing, lead with concrete defects and cite files, commands, or evidence.",
    "Before final output, summarize what changed, what was verified, and any remaining risk or unrun checks."
  ].join("\n");
  const modes = {
    plan: "Plan mode: inspect enough context to produce an implementation plan. Do not modify files unless the user explicitly asks you to proceed.",
    "always-approve": "Always-approve mode: execute the requested coding work efficiently with available tools. Tool calls may be auto-approved by policy, but git guard and path safety still apply.",
    goal: "Goal mode: persist across steps until the stated goal is genuinely handled. Track progress, make concrete improvements, and verify each meaningful change.",
    review: "Review mode: behave like a strict code reviewer. Prioritize bugs, regressions, missing tests, security risks, and unclear assumptions before summaries."
  };
  return `${base}\n${modes[mode] || modes.plan}`;
}

export async function runAgent({ cfg, cwd, prompt, mode = cfg.mode, subagent = null, maxSteps, returnSession = false, onEvent = null, includeContext = false, conversation = [], confirmTool = null, onModeChange = null }) {
  const stepLimit = resolveAgentMaxSteps(cfg, maxSteps);
  const client = new LlmClient(cfg);
  const activeModel = subagent?.model || client.provider.model;
  const modeRuntime = createModeRuntime(mode, { cfg, onModeChange });
  const resolveCfg = () => {
    const activeMode = modeRuntime.getMode();
    return activeMode === "always-approve" ? { ...cfg, alwaysApprove: true } : cfg;
  };
  const tools = createTools({ cwd, resolveCfg, confirmTool, modeRuntime });
  const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const buildSystemContent = () => [
    subagent?.system || systemForMode(modeRuntime.getMode()),
    stepLimit
      ? `Run budget: at most ${stepLimit} model steps. Track work with todo and finish with a final answer before the limit.`
      : "No step cap in this run: continue with todo tracking until the task is complete, then return a final answer instead of looping on tools.",
    loadProjectRules(cwd),
    loadRelevantMemory(prompt),
    formatActiveTodos(cwd),
    includeContext ? loadContextPack(cwd) : ""
  ].filter(Boolean).join("\n\n");
  const messages = [
    { role: "system", content: buildSystemContent() },
    ...conversation.filter((message) => message.role !== "system"),
    { role: "user", content: prompt }
  ];
  const sessionId = id("ses");
  const events = [];
  const emit = (event) => {
    const enriched = { ...event, sessionId, at: new Date().toISOString() };
    events.push(enriched);
    if (onEvent) onEvent(enriched);
  };

  const pendingToolRuns = [];
  let pendingSession = null;

  function recordToolRun(run) {
    pendingToolRuns.push({ ...run, at: new Date().toISOString(), content: String(run.content).slice(0, 2000) });
  }

  function recordSession(sessionId, session) {
    pendingSession = { sessionId, session: { ...session, createdAt: new Date().toISOString() } };
  }

  function flushState() {
    if (!pendingToolRuns.length && !pendingSession) return;
    const state = loadState();
    if (pendingSession) {
      state.sessions[pendingSession.sessionId] = pendingSession.session;
    }
    if (pendingToolRuns.length) {
      state.toolRuns.push(...pendingToolRuns);
      state.toolRuns = state.toolRuns.slice(-500);
    }
    saveState(state);
  }

  emit({ type: "agent_run_start", step: 0, maxSteps: stepLimit, mode: modeRuntime.getMode(), model: activeModel });

  for (let step = 1; stepLimit === null || step <= stepLimit; step += 1) {
    const activeMode = modeRuntime.getMode();
    emit({ type: "model_start", step, maxSteps: stepLimit, model: activeModel, mode: activeMode });
    const completion = await client.chat({
      messages,
      tools,
      model: activeModel,
      reasoning: subagent?.reasoning || cfg.reasoning
    });
    const message = assistantMessageFromCompletion(completion);
    if (!message) throw new Error("Provider returned no assistant message.");
    messages.push(message);
    const calls = message.tool_calls || [];
    emit({
      type: "model_end",
      step,
      maxSteps: stepLimit,
      toolCalls: calls.length,
      tools: calls.map((call) => call.function?.name).filter(Boolean)
    });
    if (!calls.length) {
      emit({ type: "final", step, maxSteps: stepLimit });
      recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events });
      flushState();
      const content = message.content || "";
      return returnSession ? { content, sessionId, messages } : content;
    }

    for (const call of calls) {
      const name = call.function?.name;
      const rawArgs = call.function?.arguments || "{}";
      const parsed = parseToolArgs(rawArgs);
      if (!parsed.ok) {
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          name,
          content: `Tool arguments were invalid JSON: ${parsed.error}`
        });
        continue;
      }
      const args = parsed.value;
      const selected = toolMap[name];
      emit({ type: "tool_start", step, maxSteps: stepLimit, tool: name, summary: summarizeToolArgs(name, args) });
      const startedAt = Date.now();
      let content;
      let ok = true;
      try {
        content = selected ? await selected.run(args) : `Unknown tool: ${name}`;
      } catch (error) {
        ok = false;
        content = `Tool ${name} failed: ${error.message}`;
      }
      const durationMs = Date.now() - startedAt;
      emit({ type: "tool_end", step, maxSteps: stepLimit, tool: name, ok, durationMs });
      recordToolRun({ sessionId, step, name, ok, durationMs, args, content });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: String(content).slice(0, 120000)
      });
    }

    const nextMode = modeRuntime.consumeModeChange();
    if (nextMode) {
      messages[0] = { role: "system", content: buildSystemContent() };
      emit({ type: "mode_change", step, mode: nextMode });
    }
  }

  const partialContent = lastAssistantContent(messages);
  emit({ type: "step_limit", step: stepLimit, maxSteps: stepLimit });
  recordSession(sessionId, { mode: modeRuntime.getMode(), prompt, messages, events, stopped: "step_limit" });
  flushState();
  throw new AgentStepLimitError({ maxSteps: stepLimit, events, partialContent });
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

function loadProjectRules(cwd) {
  const file = path.join(cwd, ".azycode", "rules.md");
  try {
    return `Project rules:\n${fs.readFileSync(file, "utf8")}`;
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function loadContextPack(cwd) {
  return formatContextPack(contextPack(cwd, { maxFiles: 30, maxBytes: 60000 }));
}


