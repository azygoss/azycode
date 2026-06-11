import fs from "node:fs";
import path from "node:path";
import { azyHome } from "./config.js";

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
    path.join(azyHome(), "commands"),
    path.join(path.resolve(cwd), ".azycode", "commands")
  ];
  const commands = new Map();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const parsed = parseCommandFile(path.join(dir, entry.name));
      if (parsed?.name) commands.set(parsed.name, parsed);
    }
  }
  const sorted = [...commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  _commandCacheKey = key;
  _commandCacheValue = sorted;
  return sorted;
}

export function clearCustomCommandsCache() {
  _commandCacheKey = "";
  _commandCacheValue = null;
}

export function resolveCustomCommand(line, cwd = process.cwd()) {
  const body = line.startsWith("/") ? line.slice(1).trim() : line;
  const [name, ...rest] = body.split(/\s+/);
  if (!name) return null;
  const command = loadCustomCommands(cwd).find((entry) => entry.name === name);
  if (!command) return null;
  const args = rest.join(" ").trim();
  const prompt = args
    ? `${command.prompt}\n\nUser args: ${args}`
    : command.prompt;
  return { name: command.name, prompt, description: command.description };
}

function parseCommandFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const base = path.basename(file).replace(/\.(md|txt|prompt)$/i, "");
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(base)) return null;
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (frontmatter) {
    const meta = parseFrontmatter(frontmatter[1]);
    const prompt = frontmatter[2].trim();
    if (!prompt) return null;
    return {
      name: meta.name || base,
      description: meta.description || "",
      prompt
    };
  }
  const prompt = text.trim();
  if (!prompt) return null;
  return { name: base, description: "", prompt };
}

function parseFrontmatter(text) {
  const meta = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return meta;
}