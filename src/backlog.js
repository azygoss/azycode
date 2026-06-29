/** Persistent feature backlog for long-horizon agent runs. Zero-dependency. */

import fs from "node:fs";
import path from "node:path";
import { id, loadBacklog, saveBacklog } from "./config.js";

export const BACKLOG_STATUSES = ["pending", "in_progress", "completed", "deferred", "cancelled"];
export const BACKLOG_PRIORITIES = ["critical", "high", "medium", "low"];

function workspaceKey(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function bucket(cwd) {
  const store = loadBacklog();
  const key = workspaceKey(cwd);
  store[key] ||= { items: [] };
  return { store, key, bucket: store[key] };
}

function normalizeStatus(status) {
  const next = String(status || "pending");
  if (!BACKLOG_STATUSES.includes(next)) {
    throw new Error(`Invalid backlog status: ${status}. Use one of: ${BACKLOG_STATUSES.join(", ")}`);
  }
  return next;
}

function normalizePriority(priority) {
  const next = String(priority || "medium");
  if (!BACKLOG_PRIORITIES.includes(next)) {
    throw new Error(`Invalid backlog priority: ${priority}. Use one of: ${BACKLOG_PRIORITIES.join(", ")}`);
  }
  return next;
}

export function listBacklogItems(cwd, { status = null, area = null } = {}) {
  const { bucket: store } = bucket(cwd);
  let items = [...(store.items || [])];
  if (status) {
    const statuses = Array.isArray(status) ? status : [status];
    items = items.filter((item) => statuses.includes(item.status));
  }
  if (area) {
    items = items.filter((item) => item.area === area);
  }
  return items.sort((a, b) => {
    const prio = (p) => BACKLOG_PRIORITIES.indexOf(p.priority || "medium");
    const diff = prio(a) - prio(b);
    if (diff !== 0) return diff;
    return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
}

export function listActiveBacklog(cwd, { goalId = null } = {}) {
  let items = listBacklogItems(cwd, { status: ["pending", "in_progress"] });
  if (goalId) {
    items = items.filter((item) => !item.goalId || item.goalId === goalId);
  }
  return items;
}

export function addBacklogItem(cwd, text, {
  status = "pending",
  priority = "medium",
  area = "general",
  goalId = null,
  tags = []
} = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Backlog item text is required.");
  const { store, bucket: storeBucket } = bucket(cwd);
  const item = {
    id: id("bl"),
    text: trimmed,
    status: normalizeStatus(status),
    priority: normalizePriority(priority),
    area: String(area || "general").trim() || "general",
    goalId: goalId ? String(goalId) : null,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  storeBucket.items.push(item);
  saveBacklog(store);
  return item;
}

export function updateBacklogItem(cwd, itemId, patch = {}) {
  const { store, bucket: storeBucket } = bucket(cwd);
  const item = storeBucket.items.find((entry) => entry.id === itemId);
  if (!item) throw new Error(`Backlog item not found: ${itemId}`);
  if (patch.text !== undefined) {
    const trimmed = String(patch.text).trim();
    if (!trimmed) throw new Error("Backlog item text cannot be empty.");
    item.text = trimmed;
  }
  if (patch.status !== undefined) item.status = normalizeStatus(patch.status);
  if (patch.priority !== undefined) item.priority = normalizePriority(patch.priority);
  if (patch.area !== undefined) item.area = String(patch.area || "general").trim() || "general";
  if (patch.tags !== undefined) item.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : [];
  item.updatedAt = new Date().toISOString();
  saveBacklog(store);
  return item;
}

export function completeBacklogItem(cwd, itemId) {
  return updateBacklogItem(cwd, itemId, { status: "completed" });
}

export function removeBacklogItem(cwd, itemId) {
  const { store, bucket: storeBucket } = bucket(cwd);
  const before = storeBucket.items.length;
  storeBucket.items = storeBucket.items.filter((entry) => entry.id !== itemId);
  if (storeBucket.items.length === before) throw new Error(`Backlog item not found: ${itemId}`);
  saveBacklog(store);
  return true;
}

export function formatBacklogList(items) {
  if (!items.length) return "No backlog items.";
  return items.map((item) => {
    const tags = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
    return `- ${item.id} (${item.status}, ${item.priority}) [${item.area}] ${item.text}${tags}`;
  }).join("\n");
}

export function formatActiveBacklog(cwd, { goalId = null } = {}) {
  const items = listActiveBacklog(cwd, { goalId });
  if (!items.length) return "";
  return `Feature backlog:\n${formatBacklogList(items)}`;
}

export function serializeBacklogForHandoff(cwd, { goalId = null } = {}) {
  const active = listActiveBacklog(cwd, { goalId });
  const completed = listBacklogItems(cwd, { status: "completed" }).slice(-8);
  return { active, completed, total: active.length + completed.length };
}

export function runBacklogAction(cwd, action, args = {}) {
  switch (action) {
    case "list": {
      const items = listBacklogItems(cwd, {
        status: args.status ? (Array.isArray(args.status) ? args.status : [args.status]) : null,
        area: args.area || null
      });
      return formatBacklogList(items);
    }
    case "add": {
      const item = addBacklogItem(cwd, args.text, {
        status: args.status,
        priority: args.priority,
        area: args.area,
        goalId: args.goalId,
        tags: args.tags
      });
      return `added ${item.id} (${item.status}, ${item.priority}): ${item.text}`;
    }
    case "update": {
      if (!args.id) throw new Error("Backlog id is required for update.");
      const item = updateBacklogItem(cwd, args.id, {
        text: args.text,
        status: args.status,
        priority: args.priority,
        area: args.area,
        tags: args.tags
      });
      return `updated ${item.id} (${item.status}): ${item.text}`;
    }
    case "complete": {
      if (!args.id) throw new Error("Backlog id is required for complete.");
      const item = completeBacklogItem(cwd, args.id);
      return `completed ${item.id}: ${item.text}`;
    }
    case "remove": {
      if (!args.id) throw new Error("Backlog id is required for remove.");
      removeBacklogItem(cwd, args.id);
      return `removed ${args.id}`;
    }
    default:
      throw new Error(`Unknown backlog action: ${action}. Use list, add, update, complete, or remove.`);
  }
}