import fs from "node:fs";
import path from "node:path";
import { azyHome, ensureHome } from "./config.js";

export function memoryPath() {
  return path.join(azyHome(), "memory.json");
}

export function loadMemory() {
  ensureHome();
  try {
    return JSON.parse(fs.readFileSync(memoryPath(), "utf8"));
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
}

export function addMemory(text, tags = []) {
  const memory = loadMemory();
  const note = {
    id: `mem_${Date.now()}`,
    text,
    tags,
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
