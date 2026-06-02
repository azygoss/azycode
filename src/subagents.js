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
