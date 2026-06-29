import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendProgressEntry,
  clearProgressLog,
  formatRecentProgress,
  listProgressEntries,
  serializeProgressForHandoff,
  summarizeProgressForCompaction
} from "../src/progress-log.js";

test("appendProgressEntry persists entries with levels", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-"));
  process.env.AZYCODE_HOME = home;

  appendProgressEntry(cwd, "started safety hardening", { level: "info", area: "safety" });
  appendProgressEntry(cwd, "completed path-guard tests", { level: "milestone", area: "safety" });
  const entries = listProgressEntries(cwd);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].level, "milestone");
});

test("listProgressEntries filters by sessionId and goalId", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-2-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-2-"));
  process.env.AZYCODE_HOME = home;

  appendProgressEntry(cwd, "unscoped entry");
  appendProgressEntry(cwd, "session A", { sessionId: "ses_a", goalId: "goal_a" });
  appendProgressEntry(cwd, "session B", { sessionId: "ses_b", goalId: "goal_b" });
  appendProgressEntry(cwd, "goal X", { goalId: "goal_x", sessionId: "ses_c" });
  assert.equal(listProgressEntries(cwd, { sessionId: "ses_a" }).length, 2);
  assert.equal(listProgressEntries(cwd, { goalId: "goal_x" }).length, 2);
});

test("serializeProgressForHandoff captures milestones and blockers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-3-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-3-"));
  process.env.AZYCODE_HOME = home;

  appendProgressEntry(cwd, "blocked on credentials", { level: "blocker" });
  appendProgressEntry(cwd, "tests pass", { level: "milestone" });
  const snapshot = serializeProgressForHandoff(cwd);
  assert.equal(snapshot.blockers.length, 1);
  assert.equal(snapshot.milestones.length, 1);
  assert.match(snapshot.blockers[0].message, /credentials/);
});

test("summarizeProgressForCompaction includes blockers", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-4-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-4-"));
  process.env.AZYCODE_HOME = home;

  appendProgressEntry(cwd, "waiting on docker", { level: "blocker" });
  const summary = summarizeProgressForCompaction(cwd);
  assert.match(summary, /Progress log/);
  assert.match(summary, /Active blockers/);
  assert.match(summary, /docker/);
});

test("clearProgressLog removes all entries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-5-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-5-"));
  process.env.AZYCODE_HOME = home;

  appendProgressEntry(cwd, "one");
  appendProgressEntry(cwd, "two");
  const removed = clearProgressLog(cwd);
  assert.equal(removed, 2);
  assert.equal(listProgressEntries(cwd).length, 0);
});

test("formatRecentProgress returns empty string when no entries", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-home-6-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "azy-prog-cwd-6-"));
  process.env.AZYCODE_HOME = home;
  assert.equal(formatRecentProgress(cwd), "");
});