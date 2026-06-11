import fs from "node:fs";
import path from "node:path";
import { azyHome, loadConfig, saveConfig } from "./config.js";

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 200;
const MAX_TEXT = 10000;

export function listSkills(cfg, { scope = null } = {}) {
  const globalSkills = Object.entries(cfg.skills || {}).map(([name, skill]) => ({
    name,
    ...normalizeSkillRecord(name, skill, "global")
  }));
  if (scope === "global") return globalSkills;
  if (scope === "project") return [];
  return globalSkills;
}

export function listProjectSkills(cwd = process.cwd()) {
  const dir = path.join(path.resolve(cwd), ".azycode", "skills");
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parsed = parseSkillFile(path.join(dir, entry.name));
    if (parsed) skills.push(parsed);
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listAllSkills(cfg = loadConfig(), cwd = process.cwd()) {
  const global = listSkills(cfg);
  const project = listProjectSkills(cwd);
  const byName = new Map();
  for (const skill of global) byName.set(skill.name, skill);
  for (const skill of project) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function addSkill({ name, description = "", text = "", scope = "global", activation = [], tags = [] }) {
  validateSkillName(name);
  const record = normalizeSkillInput({ description, text, scope, activation, tags });
  if (scope === "project") {
    throw new Error("Project skills must be created in .azycode/skills/<name>.md");
  }
  const cfg = loadConfig();
  cfg.skills ||= {};
  cfg.skills[name] = record;
  saveConfig(cfg);
  return { name, ...record };
}

export function writeProjectSkill(cwd, { name, description = "", text = "", activation = [], tags = [] }) {
  validateSkillName(name);
  const record = normalizeSkillInput({ description, text, scope: "project", activation, tags });
  const dir = path.join(path.resolve(cwd), ".azycode", "skills");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.md`);
  const body = [
    "---",
    `description: ${record.description}`,
    "scope: project",
    record.activation.length ? `activation: ${record.activation.join(", ")}` : null,
    record.tags.length ? `tags: ${record.tags.join(", ")}` : null,
    "---",
    "",
    record.text
  ].filter((line) => line !== null).join("\n");
  fs.writeFileSync(file, body, "utf8");
  return { name, ...record, source: file };
}

export function removeSkill(name, { scope = "global", cwd = process.cwd() } = {}) {
  if (scope === "project") {
    const file = path.join(path.resolve(cwd), ".azycode", "skills", `${name}.md`);
    if (!fs.existsSync(file)) throw new Error(`No project skill named ${name}.`);
    fs.unlinkSync(file);
    return true;
  }
  const cfg = loadConfig();
  if (!cfg.skills?.[name]) throw new Error(`No skill named ${name}.`);
  delete cfg.skills[name];
  saveConfig(cfg);
  return true;
}

export function getSkillRecord(name, cfg = loadConfig(), cwd = process.cwd()) {
  const project = listProjectSkills(cwd).find((skill) => skill.name === name);
  if (project) return project;
  const global = cfg.skills?.[name];
  if (!global) return null;
  return normalizeSkillRecord(name, global, "global");
}

export function getSkillText(cfg, names, { cwd = process.cwd(), prompt = "" } = {}) {
  const requested = Array.isArray(names) ? names : [];
  const auto = resolveActiveSkills(cfg, cwd, { prompt, explicit: requested });
  const selected = requested.length ? requested : auto.map((skill) => skill.name);
  if (!selected.length) return "";

  const texts = [];
  for (const name of selected) {
    const skill = getSkillRecord(name, cfg, cwd);
    if (skill?.text) texts.push(skill.text);
  }
  if (!texts.length) return "";
  return `Applied skills:\n${texts.map((t) => `- ${t}`).join("\n")}`;
}

export function resolveActiveSkills(cfg = loadConfig(), cwd = process.cwd(), { prompt = "", explicit = [] } = {}) {
  const all = listAllSkills(cfg, cwd);
  const explicitSet = new Set(explicit || []);
  const promptLower = String(prompt || "").toLowerCase();
  return all.filter((skill) => {
    if (explicitSet.has(skill.name)) return true;
    if (!skill.activation?.length || !promptLower) return false;
    return skill.activation.some((rule) => promptLower.includes(String(rule).toLowerCase()));
  });
}

export function exportSkill(name, { cfg = loadConfig(), cwd = process.cwd(), file = null } = {}) {
  const skill = getSkillRecord(name, cfg, cwd);
  if (!skill) throw new Error(`No skill named ${name}.`);
  const payload = {
    version: 1,
    name: skill.name,
    description: skill.description,
    text: skill.text,
    scope: skill.scope,
    activation: skill.activation || [],
    tags: skill.tags || []
  };
  const output = `${JSON.stringify(payload, null, 2)}\n`;
  if (file) {
    fs.writeFileSync(file, output, "utf8");
    return file;
  }
  return output;
}

export function importSkill(file, { scope = "global", cwd = process.cwd() } = {}) {
  const raw = fs.readFileSync(file, "utf8");
  let payload;
  if (file.endsWith(".md")) {
    payload = parseSkillFile(file);
    if (!payload) throw new Error(`Invalid skill file: ${file}`);
  } else {
    payload = JSON.parse(raw);
  }
  validateSkillName(payload.name);
  const record = normalizeSkillInput(payload);
  if ((payload.scope || scope) === "project") {
    return writeProjectSkill(cwd, { name: payload.name, ...record });
  }
  const cfg = loadConfig();
  cfg.skills ||= {};
  cfg.skills[payload.name] = record;
  saveConfig(cfg);
  return { name: payload.name, ...record };
}

export function formatSkillsList(items) {
  if (!items.length) return "No skills.";
  return items.map((item) => {
    const desc = item.description ? ` · ${item.description}` : "";
    const scope = item.scope ? ` [${item.scope}]` : "";
    const activation = item.activation?.length ? ` · activates: ${item.activation.join(", ")}` : "";
    return `- ${item.name}${scope}${desc}${activation}`;
  }).join("\n");
}

function validateSkillName(name) {
  if (!NAME_PATTERN.test(name)) {
    throw new Error("Skill name must start with a letter and contain only letters, numbers, _ or -.");
  }
  if (name.length > MAX_NAME) throw new Error("Skill name must be at most 64 characters.");
}

function normalizeSkillInput({ description = "", text = "", scope = "global", activation = [], tags = [] }) {
  const trimmedDesc = String(description || "").trim();
  const trimmedText = String(text || "").trim();
  if (trimmedDesc.length > MAX_DESCRIPTION) throw new Error("Skill description must be at most 200 characters.");
  if (trimmedText.length > MAX_TEXT) throw new Error("Skill text must be at most 10000 characters.");
  const activationRules = Array.isArray(activation)
    ? activation.map(String)
    : String(activation || "").split(",").map((part) => part.trim()).filter(Boolean);
  const tagList = Array.isArray(tags)
    ? tags.map(String)
    : String(tags || "").split(",").map((part) => part.trim()).filter(Boolean);
  return {
    description: trimmedDesc,
    text: trimmedText,
    scope: scope === "project" ? "project" : "global",
    activation: activationRules,
    tags: tagList
  };
}

function normalizeSkillRecord(name, skill, scope) {
  return {
    name,
    description: skill.description || "",
    text: skill.text || "",
    scope: skill.scope || scope,
    activation: Array.isArray(skill.activation) ? skill.activation : [],
    tags: Array.isArray(skill.tags) ? skill.tags : [],
    source: skill.source || null
  };
}

function parseSkillFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const base = path.basename(file).replace(/\.md$/i, "");
  if (!NAME_PATTERN.test(base)) return null;
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!frontmatter) {
    const body = text.trim();
    if (!body) return null;
    return { name: base, description: "", text: body, scope: "project", activation: [], tags: [], source: file };
  }
  const meta = {};
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  const body = frontmatter[2].trim();
  if (!body) return null;
  return normalizeSkillRecord(meta.name || base, {
    description: meta.description || "",
    text: body,
    scope: meta.scope || "project",
    activation: meta.activation ? meta.activation.split(",").map((part) => part.trim()).filter(Boolean) : [],
    tags: meta.tags ? meta.tags.split(",").map((part) => part.trim()).filter(Boolean) : [],
    source: file
  }, meta.scope || "project");
}

export function projectSkillsDir(cwd = process.cwd()) {
  return path.join(path.resolve(cwd), ".azycode", "skills");
}

export function globalSkillsDir() {
  return path.join(azyHome(), "skills");
}