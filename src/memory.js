import fs from "node:fs";
import path from "node:path";
import { azyHome, ensureHome } from "./config.js";

export function memoryPath() {
  return path.join(azyHome(), "memory.json");
}

let _memoryCache = null;
let _memoryMtime = 0;

function memoryMtime() {
  try {
    return fs.statSync(memoryPath()).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadMemory() {
  ensureHome();
  const mtime = memoryMtime();
  if (_memoryCache && _memoryMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_memoryCache) : JSON.parse(JSON.stringify(_memoryCache));
  }
  try {
    const data = JSON.parse(fs.readFileSync(memoryPath(), "utf8"));
    _memoryCache = data;
    _memoryMtime = mtime;
    return typeof structuredClone === "function" ? structuredClone(data) : JSON.parse(JSON.stringify(data));
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, notes: [] };
    throw error;
  }
}

export function saveMemory(memory) {
  ensureHome();
  const tmp = `${memoryPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(memory, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, memoryPath());
  _memoryCache = null;
  _memoryMtime = 0;
}

export function addMemory(text, tags = []) {
  const memory = loadMemory();
  const note = {
    id: `mem_${Date.now()}`,
    text,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    createdAt: new Date().toISOString()
  };
  memory.notes.push(note);
  saveMemory(memory);
  return note;
}

export function removeMemory(id) {
  const memory = loadMemory();
  const before = memory.notes.length;
  memory.notes = memory.notes.filter((note) => note.id !== id);
  saveMemory(memory);
  return before !== memory.notes.length;
}

export function searchMemory(query = "") {
  const memory = loadMemory();
  const needles = tokenize(query);
  if (!needles.length) return memory.notes;
  return memory.notes.filter((note) => {
    const haystack = `${note.text} ${note.tags.join(" ")}`.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

function tokenize(query) {
  return String(query)
    .toLowerCase()
    .split(/[^a-z0-9_-]+/i)
    .filter((token) => token.length >= 3);
}
