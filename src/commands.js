import fs from "node:fs";
import path from "node:path";
import { azyHome } from "./config.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const MAX_DESCRIPTION = 200;
const MAX_PROMPT = 20000;
const MAX_ARGS = 4000;

let _commandCacheKey = "";
let _commandCacheValue = null;

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function commandDirsMtime(cwd) {
  const dirs = [
    path.join(azyHome(), "commands"),
    path.join(path.resolve(cwd), ".azycode", "commands")
  ];
  const parts = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      parts.push(`${dir}:missing`);
      continue;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => `${entry.name}:${fileMtime(path.join(dir, entry.name))}`)
      .sort();
    parts.push(`${dir}:${entries.join(",")}`);
  }
  return parts.join("|");
}

export function loadCustomCommands(cwd = process.cwd()) {
  const key = commandDirsMtime(cwd);
  if (_commandCacheKey === key && _commandCacheValue) {
    return _commandCacheValue;
  }
  const dirs = [
    { dir: path.join(azyHome(), "commands"), scope: "global" },
    { dir: path.join(path.resolve(cwd), ".azycode", "commands"), scope: "project" }
  ];
  const commands = new Map();
  const errors = [];
  for (const { dir, scope } of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parsed = parseCommandFile(path.join(dir, entry.name), { scope, errors });
      if (parsed?.name) commands.set(parsed.name, parsed);
    }
  }
  const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  sorted.errors = errors;
  _commandCacheKey = key;
  _commandCacheValue = sorted;
  return sorted;
}

export function clearCustomCommandsCache() {
  _commandCacheKey = "";
  _commandCacheValue = null;
}

export function expandCommandArgs(template, args = "") {
  const safeArgs = String(args || "").slice(0, MAX_ARGS);
  return String(template || "").replace(/\{\{args\}\}/g, safeArgs);
}

export function previewCustomCommand(line, cwd = process.cwd()) {
  const body = line.startsWith("/") ? line.slice(1).trim() : line;
  const [name, ...rest] = body.split(/\s+/);
  if (!name) return null;
  const command = loadCustomCommands(cwd).find((entry) => entry.name === name);
  if (!command) return null;
  const args = rest.join(" ").trim();
  const prompt = expandCommandArgs(command.prompt, args);
  return {
    name: command.name,
    description: command.description,
    scope: command.scope,
    argsHint: command.argsHint,
    args,
    prompt,
    preview: prompt.slice(0, 600)
  };
}

export function resolveCustomCommand(line, cwd = process.cwd()) {
  const preview = previewCustomCommand(line, cwd);
  if (!preview) return null;
  const prompt = preview.args && !preview.prompt.includes(preview.args)
    ? `${preview.prompt}\n\nUser args: ${preview.args}`
    : preview.prompt;
  return {
    name: preview.name,
    prompt,
    description: preview.description,
    scope: preview.scope
  };
}

function parseCommandFile(file, { scope = "project", errors = [] } = {}) {
  const text = fs.readFileSync(file, "utf8");
  const base = path.basename(file).replace(/\.(md|txt|prompt)$/i, "");
  if (!NAME_PATTERN.test(base)) {
    errors.push(`${file}: invalid command filename '${base}'`);
    return null;
  }
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (frontmatter) {
    const meta = parseFrontmatter(frontmatter[1], file, errors);
    const prompt = frontmatter[2].trim();
    if (!prompt) {
      errors.push(`${file}: prompt body is required`);
      return null;
    }
    if (prompt.length > MAX_PROMPT) {
      errors.push(`${file}: prompt exceeds ${MAX_PROMPT} characters`);
      return null;
    }
    const name = meta.name || base;
    if (!NAME_PATTERN.test(name)) {
      errors.push(`${file}: invalid command name '${name}'`);
      return null;
    }
    return {
      name,
      description: meta.description || "",
      prompt,
      scope: meta.scope || scope,
      argsHint: meta.args || meta.argsHint || "",
      source: file
    };
  }
  const prompt = text.trim();
  if (!prompt) {
    errors.push(`${file}: empty command file`);
    return null;
  }
  return { name: base, description: "", prompt, scope, argsHint: "", source: file };
}

function parseFrontmatter(text, file, errors) {
  const meta = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (key === "name" && value && !NAME_PATTERN.test(value)) {
      errors.push(`${file}: invalid frontmatter name '${value}'`);
    }
    if (key === "description" && value.length > MAX_DESCRIPTION) {
      errors.push(`${file}: description exceeds ${MAX_DESCRIPTION} characters`);
    }
    if (key === "scope" && value && !["global", "project"].includes(value)) {
      errors.push(`${file}: scope must be global or project`);
    }
    meta[key] = value;
  }
  return meta;
}