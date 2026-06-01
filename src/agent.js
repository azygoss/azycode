import fs from "node:fs";
import path from "node:path";
import { LlmClient, assistantMessageFromCompletion } from "./llm.js";
import { createTools } from "./tools.js";
import { id, loadState, saveState } from "./config.js";
import { searchMemory } from "./memory.js";
import { contextPack, formatContextPack } from "./context.js";

export function systemForMode(mode) {
  const base = "You are Azycode, an AI coding harness. Work in small verified steps. Use tools when needed. Never claim a file changed unless a tool changed it.";
  const modes = {
    plan: "Plan mode: inspect context and produce an implementation plan. Do not modify files unless explicitly asked to proceed.",
    "always-approve": "Always-approve mode: execute the requested coding work efficiently with available tools. Tool calls are approved automatically by policy.",
    goal: "Goal mode: persist until the stated goal is complete, track progress, and verify the outcome.",
    review: "Review mode: behave like a code reviewer. Lead with defects, risks, regressions, and missing tests."
  };
  return `${base}\n${modes[mode] || modes.plan}`;
}

export async function runAgent({ cfg, cwd, prompt, mode = cfg.mode, subagent = null, maxSteps = 12, returnSession = false, onEvent = null, includeContext = false, conversation = [] }) {
  const client = new LlmClient(cfg);
  const effectiveCfg = mode === "always-approve" ? { ...cfg, alwaysApprove: true } : cfg;
  const tools = createTools({ cwd, cfg: effectiveCfg });
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
    emit({ type: "model_start", step: step + 1, model: subagent?.model || cfg.activeModel, mode });
    const completion = await client.chat({
      messages,
      tools,
      model: subagent?.model || cfg.activeModel,
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
