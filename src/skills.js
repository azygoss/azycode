import { loadConfig, saveConfig } from "./config.js";

export function listSkills(cfg) {
  return Object.entries(cfg.skills || {}).map(([name, skill]) => ({ name, ...skill }));
}

export function addSkill({ name, description = "", text = "" }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Skill name must start with a letter and contain only letters, numbers, _ or -.");
  }
  const cfg = loadConfig();
  cfg.skills ||= {};
  cfg.skills[name] = { description: String(description || "").trim(), text: String(text || "").trim() };
  saveConfig(cfg);
  return cfg.skills[name];
}

export function removeSkill(name) {
  const cfg = loadConfig();
  if (!cfg.skills?.[name]) throw new Error(`No skill named ${name}.`);
  delete cfg.skills[name];
  saveConfig(cfg);
}

export function getSkillText(cfg, names) {
  if (!names || !names.length) return "";
  const skills = cfg.skills || {};
  const texts = [];
  for (const name of names) {
    const skill = skills[name];
    if (skill?.text) texts.push(skill.text);
  }
  if (!texts.length) return "";
  return `Applied skills:\n${texts.map((t) => `- ${t}`).join("\n")}`;
}

export function formatSkillsList(items) {
  if (!items.length) return "No skills.";
  return items.map((item) => {
    const desc = item.description ? ` · ${item.description}` : "";
    return `- ${item.name}${desc}`;
  }).join("\n");
}
