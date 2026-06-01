import { loadConfig, saveConfig } from "./config.js";

export function listSubagents(cfg) {
  return Object.entries(cfg.subagents || {}).map(([name, agent]) => ({ name, ...agent }));
}

export function addSubagent({ name, description, system, model = null, reasoning = "medium" }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Subagent name must start with a letter and contain only letters, numbers, _ or -.");
  }
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
