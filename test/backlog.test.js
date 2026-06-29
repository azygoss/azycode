import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addBacklogItem,
  completeBacklogItem,
  formatActiveBacklog,
  listActiveBacklog,
  listBacklogItems,
  serializeBacklogForHandoff,
  updateBacklogItem
} from "../src/backlog.js";

test("addBacklogItem persists and lists by priority", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-"));
  process.env.AZYCODE_HOME = home;

  addBacklogItem(cwd, "low priority task", { priority: "low" });
  addBacklogItem(cwd, "critical security fix", { priority: "critical", area: "safety" });
  const items = listBacklogItems(cwd);
  assert.equal(items.length, 2);
  assert.equal(items[0].priority, "critical");
  assert.equal(items[0].area, "safety");
});

test("listActiveBacklog filters completed items", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-2-"));
  process.env.AZYCODE_HOME = home;

  const item = addBacklogItem(cwd, "implement feature X");
  addBacklogItem(cwd, "another task");
  completeBacklogItem(cwd, item.id);
  const active = listActiveBacklog(cwd);
  assert.equal(active.length, 1);
  assert.equal(active[0].text, "another task");
});

test("serializeBacklogForHandoff produces active and completed sections", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-3-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-3-"));
  process.env.AZYCODE_HOME = home;

  const done = addBacklogItem(cwd, "finished feature");
  addBacklogItem(cwd, "pending feature");
  completeBacklogItem(cwd, done.id);
  const snapshot = serializeBacklogForHandoff(cwd);
  assert.equal(snapshot.active.length, 1);
  assert.equal(snapshot.completed.length, 1);
  assert.equal(snapshot.total, 2);
});

test("formatActiveBacklog returns empty string when no items", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-4-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-4-"));
  process.env.AZYCODE_HOME = home;
  assert.equal(formatActiveBacklog(cwd), "");
});

test("listBacklogItems strict goalId excludes unscoped items", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-6-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-6-"));
  process.env.AZYCODE_HOME = home;

  addBacklogItem(cwd, "global");
  addBacklogItem(cwd, "for goal", { goalId: "g1" });
  assert.equal(listBacklogItems(cwd, { goalId: "g1", scope: "strict" }).length, 1);
  assert.equal(listBacklogItems(cwd, { goalId: "g1", scope: "inclusive" }).length, 2);
});

test("updateBacklogItem changes status and priority", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-home-5-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-bl-cwd-5-"));
  process.env.AZYCODE_HOME = home;

  const item = addBacklogItem(cwd, "task");
  const updated = updateBacklogItem(cwd, item.id, { status: "in_progress", priority: "high" });
  assert.equal(updated.status, "in_progress");
  assert.equal(updated.priority, "high");
});