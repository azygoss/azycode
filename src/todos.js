import fs from "node:fs";
import path from "node:path";
import { id, loadTodos, saveTodos } from "./config.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"];

function workspaceKey(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function bucket(cwd) {
  const todos = loadTodos();
  const key = workspaceKey(cwd);
  todos[key] ||= { items: [] };
  return { todos, key, bucket: todos[key] };
}

export function listTodos(cwd, { status = null } = {}) {
  const { bucket: store } = bucket(cwd);
  const items = store.items || [];
  if (!status) return [...items];
  const statuses = Array.isArray(status) ? status : [status];
  return items.filter((item) => statuses.includes(item.status));
}

export function formatTodoList(items) {
  if (!items.length) return "No todos.";
  return items.map((item) => {
    const tags = item.tags?.length ? ` [${item.tags.join(", ")}]` : "";
    return `- ${item.id} (${item.status}) ${item.text}${tags}`;
  }).join("\n");
}

export function addTodo(cwd, text, { status = "pending", tags = [], sessionId = null } = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) throw new Error("Todo text is required.");
  const nextStatus = normalizeTodoStatus(status);
  const { todos, bucket: store } = bucket(cwd);
  const item = {
    id: id("todo"),
    text: trimmed,
    status: nextStatus,
    tags: Array.isArray(tags) ? tags.map(String) : [],
    sessionId: sessionId ? String(sessionId) : null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  store.items.push(item);
  saveTodos(todos);
  return item;
}

export function updateTodo(cwd, todoId, patch = {}) {
  const { todos, bucket: store } = bucket(cwd);
  const item = store.items.find((entry) => entry.id === todoId);
  if (!item) throw new Error(`Todo not found: ${todoId}`);
  if (patch.text !== undefined) {
    const trimmed = String(patch.text).trim();
    if (!trimmed) throw new Error("Todo text cannot be empty.");
    item.text = trimmed;
  }
  if (patch.status !== undefined) item.status = normalizeTodoStatus(patch.status);
  if (patch.tags !== undefined) item.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : [];
  item.updatedAt = new Date().toISOString();
  saveTodos(todos);
  return item;
}

export function completeTodo(cwd, todoId) {
  return updateTodo(cwd, todoId, { status: "completed" });
}

export function removeTodo(cwd, todoId) {
  const { todos, bucket: store } = bucket(cwd);
  const before = store.items.length;
  store.items = store.items.filter((entry) => entry.id !== todoId);
  if (store.items.length === before) throw new Error(`Todo not found: ${todoId}`);
  saveTodos(todos);
  return true;
}

export function clearCompletedTodos(cwd) {
  const { todos, bucket: store } = bucket(cwd);
  const before = store.items.length;
  store.items = store.items.filter((entry) => entry.status !== "completed" && entry.status !== "cancelled");
  const removed = before - store.items.length;
  saveTodos(todos);
  return removed;
}

export function listActiveTodos(cwd, { sessionId = null } = {}) {
  let items = listTodos(cwd, { status: ["pending", "in_progress"] });
  if (sessionId) {
    items = items.filter((item) => !item.sessionId || item.sessionId === sessionId);
  }
  return items;
}

export function clearAllTodos(cwd) {
  const { todos, bucket: store } = bucket(cwd);
  const removed = store.items.length;
  store.items = [];
  saveTodos(todos);
  return removed;
}

export function formatActiveTodos(cwd, { sessionId = null } = {}) {
  const items = listActiveTodos(cwd, { sessionId });
  if (!items.length) return "";
  return `Workspace todos:\n${formatTodoList(items)}`;
}

export function runTodoAction(cwd, action, args = {}) {
  switch (action) {
    case "list": {
      const status = args.status ? (Array.isArray(args.status) ? args.status : [args.status]) : null;
      const items = status ? listTodos(cwd, { status }) : listTodos(cwd);
      return formatTodoList(items);
    }
    case "add": {
      const item = addTodo(cwd, args.text, { status: args.status, tags: args.tags });
      return `added ${item.id} (${item.status}): ${item.text}`;
    }
    case "update": {
      if (!args.id) throw new Error("Todo id is required for update.");
      const item = updateTodo(cwd, args.id, { text: args.text, status: args.status, tags: args.tags });
      return `updated ${item.id} (${item.status}): ${item.text}`;
    }
    case "complete": {
      if (!args.id) throw new Error("Todo id is required for complete.");
      const item = completeTodo(cwd, args.id);
      return `completed ${item.id}: ${item.text}`;
    }
    case "remove": {
      if (!args.id) throw new Error("Todo id is required for remove.");
      removeTodo(cwd, args.id);
      return `removed ${args.id}`;
    }
    case "clear_completed": {
      const removed = clearCompletedTodos(cwd);
      return `cleared ${removed} completed/cancelled todo(s)`;
    }
    default:
      throw new Error(`Unknown todo action: ${action}. Use list, add, update, complete, remove, or clear_completed.`);
  }
}

function normalizeTodoStatus(status) {
  const next = String(status || "pending");
  if (!TODO_STATUSES.includes(next)) {
    throw new Error(`Invalid todo status: ${status}. Use one of: ${TODO_STATUSES.join(", ")}`);
  }
  return next;
}
