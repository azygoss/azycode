import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addTodo,
  clearCompletedTodos,
  completeTodo,
  formatActiveTodos,
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