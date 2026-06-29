/** Structured progress log for long-horizon runs. Survives compaction and handoff. */

import fs from "node:fs";
import path from "node:path";
import { id, loadProgressLog, saveProgressLog } from "./config.js";

const MAX_ENTRIES_PER_WORKSPACE = 200;

function workspaceKey(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function bucket(cwd) {
  const store = loadProgressLog();
  const key = workspaceKey(cwd);
  store[key] ||= { entries: [] };
  return { store, key, bucket: store[key] };
}

export function listProgressEntries(cwd, { limit = 50, sessionId = null, goalId = null } = {}) {
  const { bucket: store } = bucket(cwd);
  let entries = [...(store.entries || [])];
  if (sessionId) entries = entries.filter((e) => !e.sessionId || e.sessionId === sessionId);
  if (goalId) entries = entries.filter((e) => !e.goalId || e.goalId === goalId);
  return entries.slice(-Math.max(1, limit));
}

export function appendProgressEntry(cwd, message, {
  sessionId = null,
  goalId = null,
  area = "general",
  level = "info",
  meta = {}
} = {}) {
  const trimmed = String(message || "").trim();
  if (!trimmed) throw new Error("Progress message is required.");
  const { store, bucket: storeBucket } = bucket(cwd);
  const entry = {
    id: id("prog"),
    message: trimmed.slice(0, 2000),
    area: String(area || "general").trim() || "general",
    level: ["info", "warn", "milestone", "blocker"].includes(level) ? level : "info",
    sessionId: sessionId ? String(sessionId) : null,
    goalId: goalId ? String(goalId) : null,
    meta: meta && typeof meta === "object" ? meta : {},
    at: new Date().toISOString()
  };
  storeBucket.entries.push(entry);
  if (storeBucket.entries.length > MAX_ENTRIES_PER_WORKSPACE) {
    storeBucket.entries = storeBucket.entries.slice(-MAX_ENTRIES_PER_WORKSPACE);
  }
  saveProgressLog(store);
  return entry;
}

export function clearProgressLog(cwd, { before = null } = {}) {
  const { store, bucket: storeBucket } = bucket(cwd);
  const beforeMs = before ? Date.parse(before) : null;
  const beforeCount = storeBucket.entries.length;
  if (beforeMs) {
    storeBucket.entries = storeBucket.entries.filter((e) => Date.parse(e.at) >= beforeMs);
  } else {
    storeBucket.entries = [];
  }
  const removed = beforeCount - storeBucket.entries.length;
  saveProgressLog(store);
  return removed;
}

export function formatProgressList(entries) {
  if (!entries.length) return "No progress entries.";
  return entries.map((entry) => {
    const prefix = entry.level === "milestone" ? "★" : entry.level === "blocker" ? "⚠" : "·";
    const area = entry.area && entry.area !== "general" ? ` [${entry.area}]` : "";
    return `${prefix} ${entry.at}${area}: ${entry.message}`;
  }).join("\n");
}

export function formatRecentProgress(cwd, { limit = 12, sessionId = null, goalId = null } = {}) {
  const entries = listProgressEntries(cwd, { limit, sessionId, goalId });
  if (!entries.length) return "";
  return `Recent progress:\n${formatProgressList(entries)}`;
}

export function serializeProgressForHandoff(cwd, { sessionId = null, goalId = null, limit = 20 } = {}) {
  const entries = listProgressEntries(cwd, { limit, sessionId, goalId });
  const milestones = entries.filter((e) => e.level === "milestone");
  const blockers = entries.filter((e) => e.level === "blocker");
  return { entries, milestones, blockers, total: entries.length };
}

export function summarizeProgressForCompaction(cwd, { sessionId = null, goalId = null } = {}) {
  const entries = listProgressEntries(cwd, { limit: 8, sessionId, goalId });
  if (!entries.length) return "";
  const lines = entries.map((e) => `- ${e.message}`);
  const blockers = entries.filter((e) => e.level === "blocker");
  const parts = [`Progress log (${entries.length} recent):`, ...lines];
  if (blockers.length) {
    parts.push(`Active blockers: ${blockers.map((b) => b.message).join("; ")}`);
  }
  return parts.join("\n");
}

export function runProgressAction(cwd, action, args = {}) {
  switch (action) {
    case "list": {
      const entries = listProgressEntries(cwd, {
        limit: args.limit || 50,
        sessionId: args.sessionId || null,
        goalId: args.goalId || null
      });
      return formatProgressList(entries);
    }
    case "add": {
      const entry = appendProgressEntry(cwd, args.message, {
        sessionId: args.sessionId,
        goalId: args.goalId,
        area: args.area,
        level: args.level,
        meta: args.meta
      });
      return `logged ${entry.id}: ${entry.message}`;
    }
    case "clear": {
      const removed = clearProgressLog(cwd, { before: args.before || null });
      return `cleared ${removed} progress entr${removed === 1 ? "y" : "ies"}`;
    }
    default:
      throw new Error(`Unknown progress action: ${action}. Use list, add, or clear.`);
  }
}