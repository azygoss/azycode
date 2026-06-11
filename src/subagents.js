import { runAgent } from "./agent.js";
import { loadConfig, saveConfig } from "./config.js";

export function listSubagents(cfg) {
  return Object.entries(cfg.subagents || {}).map(([name, agent]) => ({ name, ...agent }));
}

export function addSubagent({ name, description, system, model = null, reasoning = "medium" }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Subagent name must start with a letter and contain only letters, numbers, _ or -.");
  }
  if (name.length > 64) throw new Error("Subagent name must be at most 64 characters.");
  if (description && String(description).length > 200) throw new Error("Subagent description must be at most 200 characters.");
  if (system && String(system).length > 10000) throw new Error("Subagent system prompt must be at most 10000 characters.");
  const cfg = loadConfig();
  cfg.subagents ||= {};
  cfg.subagents[name] = { description, system, model, reasoning };
  saveConfig(cfg);
  return cfg.subagents[name];
}

export function removeSubagent(name) {
  const cfg = loadConfig();
  if (!cfg.subagents?.[name]) throw new Error(`No subagent named ${name}.`);
  delete cfg.subagents[name];
  saveConfig(cfg);
}

export async function runSubagentsParallel({
  cfg,
  cwd,
  tasks = [],
  signal = null,
  maxParallel = 4,
  maxStepsPerAgent = 8,
  subagentDepth = 0,
  onSubagentEvent = null
} = {}) {
  const limit = Math.max(1, Math.min(8, Number(maxParallel) || 4));
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const maxDepth = Number.isFinite(Number(cfg.maxSubagentDepth))
    ? Math.max(0, Math.floor(Number(cfg.maxSubagentDepth)))
    : 2;
  if (subagentDepth >= maxDepth) {
    return allTasks.map((task, index) => ({
      index: index + 1,
      agent: task?.agent,
      ok: false,
      error: `Subagent nesting depth limit (${maxDepth}) reached.`
    }));
  }
  const results = [];
  for (let offset = 0; offset < allTasks.length; offset += limit) {
    const batch = allTasks.slice(offset, offset + limit);
    const batchResults = await Promise.all(batch.map(async (task, batchIndex) => {
      const index = offset + batchIndex + 1;
      const agentName = task?.agent;
      const profile = cfg.subagents?.[agentName];
      if (!profile) {
        return { index, agent: agentName, ok: false, error: `Unknown subagent: ${agentName}` };
      }
      const startedAt = Date.now();
      onSubagentEvent?.({ type: "subagent_start", agent: agentName, index, prompt: task.prompt });
      try {
        const output = await runAgent({
          cfg: { ...cfg, alwaysApprove: true },
          cwd,
          prompt: String(task.prompt || ""),
          mode: task.mode || "always-approve",
          subagent: { name: agentName, ...profile },
          maxSteps: Number(task.maxSteps) > 0 ? Number(task.maxSteps) : maxStepsPerAgent,
          signal,
          subagentDepth,
          progressStyle: "tui"
        });
        const result = {
          index,
          agent: agentName,
          ok: true,
          output: String(output),
          durationMs: Date.now() - startedAt
        };
        onSubagentEvent?.({ type: "subagent_end", ...result });
        return result;
      } catch (error) {
        const result = {
          index,
          agent: agentName,
          ok: false,
          error: error.message,
          output: error.partialContent || "",
          durationMs: Date.now() - startedAt
        };
        onSubagentEvent?.({ type: "subagent_end", ...result });
        return result;
      }
    }));
    results.push(...batchResults);
  }
  return results;
}

export function formatSubagentResults(results = []) {
  return results.map((result) => {
    const header = `## Subagent ${result.index}: ${result.agent} (${result.ok ? "ok" : "failed"})`;
    const body = result.ok ? result.output : `ERROR: ${result.error}\n${result.output || ""}`.trim();
    return `${header}\n${body}`;
  }).join("\n\n");
}
