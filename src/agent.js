import fs from "node:fs";
import path from "node:path";
import { LlmClient, assistantMessageFromCompletion } from "./llm.js";
import { createTools } from "./tools.js";
import { id, loadState, saveState } from "./config.js";
import { searchMemory } from "./memory.js";
import { contextPack, formatContextPack } from "./context.js";

export function systemForMode(mode) {
  const base = [
    "You are Azycode, an AI coding harness running inside the user's local repository.",
    "Operate like a senior coding agent: inspect current files before changing them, keep edits scoped, and verify behavior with the most relevant available checks.",
    "Use bounded tools deliberately: prefer search/list/file_info before broad reads, use read_file line ranges for large files, and use search maxResults/contextLines to keep context small.",
    "Do not claim a file changed unless a write/edit/copy/move/delete/apply_patch/shell tool actually changed it.",
    "Respect tool policy and git guard. If a write-like tool is rejected or blocked, explain the blocker and continue with safe inspection when useful.",
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

export async function runAgent({ cfg, cwd, prompt, mode = cfg.mode, subagent = null, maxSteps = 12, returnSession = false, onEvent = null, includeContext = false, conversation = [], confirmTool = null }) {
  const client = new LlmClient(cfg);
  const activeModel = subagent?.model || client.provider.model;
  const effectiveCfg = mode === "always-approve" ? { ...cfg, alwaysApprove: true } : cfg;
  const tools = createTools({ cwd, cfg: effectiveCfg, confirmTool });
  const toolMap = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  const messages = [
    { role: "system", content: [subagent?.system || systemForMode(mode), loadProjectRules(cwd), loadRelevantMemory(prompt), includeContext ? loadContextPack(cwd) : ""].filter(Boolean).join("\n\n") },
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

  for (let step = 0; step < maxSteps; step += 1) {
    emit({ type: "model_start", step: step + 1, model: activeModel, mode });
    const completion = await client.chat({
      messages,
      tools,
      model: activeModel,
      reasoning: subagent?.reasoning || cfg.reasoning
    });
    const message = assistantMessageFromCompletion(completion);
    if (!message) throw new Error("Provider returned no assistant message.");
    messages.push(message);
    emit({ type: "model_end", step: step + 1, toolCalls: (message.tool_calls || []).length });

    const calls = message.tool_calls || [];
    if (!calls.length) {
      emit({ type: "final", step: step + 1 });
      recordSession(sessionId, { mode, prompt, messages, events });
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
      emit({ type: "tool_start", step: step + 1, tool: name });
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
      emit({ type: "tool_end", step: step + 1, tool: name, ok, durationMs });
      recordToolRun({ sessionId, step: step + 1, name, ok, durationMs, args, content });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        name,
        content: String(content).slice(0, 120000)
      });
    }
  }

  recordSession(sessionId, { mode, prompt, messages, events });
  throw new Error(`Agent stopped after ${maxSteps} steps without a final answer.`);
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

function recordSession(sessionId, session) {
  const state = loadState();
  state.sessions[sessionId] = { ...session, createdAt: new Date().toISOString() };
  saveState(state);
}

function recordToolRun(run) {
  const state = loadState();
  state.toolRuns.push({ ...run, at: new Date().toISOString(), content: String(run.content).slice(0, 2000) });
  state.toolRuns = state.toolRuns.slice(-500);
  saveState(state);
}
