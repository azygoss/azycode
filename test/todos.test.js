import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addTodo,
  clearAllTodos,
  clearCompletedTodos,
  completeTodo,
  formatActiveTodos,
  listActiveTodos,
  listTodos,
  runTodoAction,
  updateTodo
} from "../src/todos.js";

test("todo actions manage workspace-scoped items", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-todos-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-"));
  process.env.AZYCODE_HOME = home;

  const added = addTodo(cwd, "Implement todo tool", { tags: ["harness"] });
  assert.match(added.id, /^todo_/);
  assert.equal(added.status, "pending");

  updateTodo(cwd, added.id, { status: "in_progress" });
  assert.equal(listTodos(cwd, { status: "in_progress" }).length, 1);

  const listed = runTodoAction(cwd, "list");
  assert.match(listed, /Implement todo tool/);

  completeTodo(cwd, added.id);
  assert.equal(listTodos(cwd, { status: "completed" }).length, 1);

  const removed = clearCompletedTodos(cwd);
  assert.equal(removed, 1);
  assert.equal(listTodos(cwd).length, 0);
});

test("todos can be scoped to a session id", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-todos-session-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-session-"));
  process.env.AZYCODE_HOME = home;

  addTodo(cwd, "Session task", { sessionId: "ses_a" });
  addTodo(cwd, "Other task", { sessionId: "ses_b" });

  assert.equal(listActiveTodos(cwd, { sessionId: "ses_a" }).length, 1);
  assert.match(formatActiveTodos(cwd, { sessionId: "ses_a" }), /Session task/);
  assert.doesNotMatch(formatActiveTodos(cwd, { sessionId: "ses_a" }), /Other task/);
});

test("clearAllTodos removes every workspace item", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-todos-clear-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-clear-"));
  process.env.AZYCODE_HOME = home;
  addTodo(cwd, "One");
  addTodo(cwd, "Two");
  assert.equal(clearAllTodos(cwd), 2);
  assert.equal(listTodos(cwd).length, 0);
});

test("formatActiveTodos returns only open items", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-todos-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-work-2-"));
  process.env.AZYCODE_HOME = home;

  addTodo(cwd, "Open task");
  const done = addTodo(cwd, "Done task");
  completeTodo(cwd, done.id);

  const formatted = formatActiveTodos(cwd);
  assert.match(formatted, /Open task/);
  assert.doesNotMatch(formatted, /Done task/);
});