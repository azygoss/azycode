import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { azyHome } from "./config.js";

const DEFAULT_MAX_BYTES = 32 * 1024;
const PRIMARY_NAMES = ["AGENTS.override.md", "AGENTS.md"];

let _instructionCacheKey = "";
let _instructionCacheValue = "";

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function samePath(left, right) {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
}

function gitRootFor(cwd) {
  try {
    return fs.realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim());
  } catch {
    return fs.realpathSync(path.resolve(cwd));
  }
}

function projectDirs(cwd) {
  const root = fs.realpathSync(path.resolve(cwd));
  const stop = gitRootFor(root);
  const dirs = [];
  let current = root;
  while (true) {
    dirs.unshift(current);
    if (samePath(current, stop)) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function instructionCacheKey(cwd, maxBytes, fallbackNames) {
  const root = path.resolve(cwd);
  const parts = [String(maxBytes), fileMtime(path.join(azyHome(), PRIMARY_NAMES[0])), fileMtime(path.join(azyHome(), PRIMARY_NAMES[1]))];
  const dirs = projectDirs(root);
  for (const dir of dirs) {
    for (const name of [...PRIMARY_NAMES, ...fallbackNames]) {
      parts.push(`${dir}/${name}:${fileMtime(path.join(dir, name))}`);
    }
  }
  return parts.join("|");
}

export function discoverProjectInstructions(cwd, {
  maxBytes = DEFAULT_MAX_BYTES,
  fallbackNames = [".azycode/rules.md"]
} = {}) {
  const cacheKey = instructionCacheKey(cwd, maxBytes, fallbackNames);
  if (_instructionCacheKey === cacheKey) return _instructionCacheValue;
  const root = path.resolve(cwd);
  const parts = [];
  let total = 0;

  function addChunk(label, text) {
    const trimmed = String(text || "").trim();
    if (!trimmed || total >= maxBytes) return false;
    const chunk = `[${label}]\n${trimmed}`;
    const room = maxBytes - total;
    if (chunk.length > room) {
      parts.push(`${chunk.slice(0, room)}\n... (instructions truncated)`);
      total = maxBytes;
      return true;
    }
    parts.push(chunk);
    total += chunk.length + 2;
    return false;
  }

  function readFirst(dir, names) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const text = fs.readFileSync(file, "utf8");
        if (String(text).trim()) return { name, text };
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return null;
  }

  const globalHit = readFirst(azyHome(), PRIMARY_NAMES);
  if (globalHit) {
    if (addChunk(`global ${globalHit.name}`, globalHit.text)) {
      const text = formatInstructions(parts);
      _instructionCacheKey = cacheKey;
      _instructionCacheValue = text;
      return text;
    }
  }

  for (const dir of projectDirs(root)) {
    const hit = readFirst(dir, PRIMARY_NAMES) || readFirst(dir, fallbackNames);
    if (hit) {
      const label = dir === root ? hit.name : `${path.relative(root, dir) || "."}/${hit.name}`;
      if (addChunk(label, hit.text)) break;
    }
  }

  const text = formatInstructions(parts);
  _instructionCacheKey = cacheKey;
  _instructionCacheValue = text;
  return text;
}

export function clearInstructionCache() {
  _instructionCacheKey = "";
  _instructionCacheValue = "";
}

function formatInstructions(parts) {
  if (!parts.length) return "";
  return `Project instructions:\n${parts.join("\n\n")}`;
}

export function listInstructionSources(cwd, { fallbackNames = [".azycode/rules.md"] } = {}) {
  const root = path.resolve(cwd);
  const sources = [];
  const globalHit = PRIMARY_NAMES.find((name) => fs.existsSync(path.join(azyHome(), name)));
  if (globalHit) sources.push(path.join(azyHome(), globalHit));

  for (const dir of projectDirs(root)) {
    const hit = PRIMARY_NAMES.find((name) => fs.existsSync(path.join(dir, name)))
      || fallbackNames.find((name) => fs.existsSync(path.join(dir, name)));
    if (hit) sources.push(path.join(dir, hit));
  }
  return sources;
}