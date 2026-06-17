import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  journalChange,
  listJournal,
  undoChange,
  undoSession,
  clearJournal,
  formatJournalReport,
  flushJournal,
  loadJournal,
  maxBackupBytes
} from "../src/change-journal.js";

function isolateHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-journal-"));
  process.env.AZYCODE_HOME = home;
  return home;
}

test("journalChange records a file backup", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const filePath = path.join(dir, "test.js");
  fs.writeFileSync(filePath, "original content");
  const id = journalChange("ses_1", "write_file", [{ path: "test.js", absPath: filePath }]);
  flushJournal();
  assert.ok(id, "should return a journal entry ID");
  const entries = listJournal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tool, "write_file");
  assert.equal(entries[0].changes[0].backup.content, "original content");
  assert.equal(entries[0].changes[0].backup.backedUp, true);
});

test("journalChange for nonexistent file records existed=false", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const filePath = path.join(dir, "nonexist.js");
  journalChange("ses_1", "write_file", [{ path: "nonexist.js", absPath: filePath }]);
  flushJournal();
  const entries = listJournal();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].changes[0].backup.existed, false);
  assert.equal(entries[0].changes[0].backup.backedUp, false);
});

test("journalChange returns null for empty files array", () => {
  isolateHome();
  const id = journalChange("ses_1", "write_file", []);
  assert.equal(id, null);
});

test("undoChange restores original file content", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const filePath = path.join(dir, "test.js");
  fs.writeFileSync(filePath, "original content");
  const id = journalChange("ses_1", "edit_file", [{ path: "test.js", absPath: filePath }]);
  flushJournal();
  // simulate edit
  fs.writeFileSync(filePath, "modified content");
  assert.equal(fs.readFileSync(filePath, "utf8"), "modified content");
  // undo
  const result = undoChange(id);
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(filePath, "utf8"), "original content");
});

test("undoChange for newly created file removes it", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const filePath = path.join(dir, "new.js");
  // journal before file existed (delete_path case where file was created)
  journalChange("ses_1", "delete_path", [{ path: "new.js", absPath: filePath }]);
  flushJournal();
  // simulate file creation
  fs.writeFileSync(filePath, "created content");
  assert.ok(fs.existsSync(filePath));
  // undo should remove it
  const entries = listJournal();
  const result = undoChange(entries[0].id);
  assert.ok(result.restored.some((r) => r.includes("new.js")));
  assert.ok(!fs.existsSync(filePath));
});

test("undoChange for missing journal ID returns error", () => {
  isolateHome();
  const result = undoChange("chg_nonexistent");
  assert.equal(result.ok, false);
  assert.equal(result.entry, null);
  assert.ok(result.errors.length > 0);
});

test("undoSession undoes all changes in a session", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file1 = path.join(dir, "a.js");
  const file2 = path.join(dir, "b.js");
  fs.writeFileSync(file1, "content a");
  fs.writeFileSync(file2, "content b");
  journalChange("ses_batch", "write_file", [{ path: "a.js", absPath: file1 }]);
  journalChange("ses_batch", "write_file", [{ path: "b.js", absPath: file2 }]);
  flushJournal();
  // simulate modifications
  fs.writeFileSync(file1, "modified a");
  fs.writeFileSync(file2, "modified b");
  const result = undoSession("ses_batch");
  assert.equal(result.undone, 2);
  assert.equal(fs.readFileSync(file1, "utf8"), "content a");
  assert.equal(fs.readFileSync(file2, "utf8"), "content b");
});

test("undoSession returns error for unknown session", () => {
  isolateHome();
  const result = undoSession("ses_nonexistent");
  assert.equal(result.ok, false);
  assert.equal(result.undone, 0);
});

test("listJournal filters by sessionId", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "x.js");
  fs.writeFileSync(file, "x");
  journalChange("ses_a", "write_file", [{ path: "x.js", absPath: file }]);
  journalChange("ses_b", "write_file", [{ path: "x.js", absPath: file }]);
  flushJournal();
  const sesA = listJournal({ sessionId: "ses_a" });
  assert.equal(sesA.length, 1);
  assert.equal(sesA[0].sessionId, "ses_a");
  const sesB = listJournal({ sessionId: "ses_b" });
  assert.equal(sesB.length, 1);
  assert.equal(sesB[0].sessionId, "ses_b");
});

test("listJournal filters by tool", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "x.js");
  fs.writeFileSync(file, "x");
  journalChange("ses_1", "write_file", [{ path: "x.js", absPath: file }]);
  journalChange("ses_1", "edit_file", [{ path: "x.js", absPath: file }]);
  flushJournal();
  const writes = listJournal({ tool: "write_file" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].tool, "write_file");
});

test("listJournal respects limit", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "x.js");
  fs.writeFileSync(file, "x");
  for (let i = 0; i < 10; i++) {
    journalChange("ses_1", "write_file", [{ path: "x.js", absPath: file }]);
  }
  flushJournal();
  const limited = listJournal({ limit: 3 });
  assert.equal(limited.length, 3);
});

test("clearJournal removes all entries", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "x.js");
  fs.writeFileSync(file, "x");
  journalChange("ses_1", "write_file", [{ path: "x.js", absPath: file }]);
  flushJournal();
  assert.equal(listJournal().length, 1);
  const count = clearJournal();
  assert.equal(count, 1);
  assert.equal(listJournal().length, 0);
});

test("formatJournalReport produces readable output", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "test.js");
  fs.writeFileSync(file, "content");
  journalChange("ses_1", "write_file", [{ path: "test.js", absPath: file }]);
  flushJournal();
  const entries = listJournal();
  const report = formatJournalReport(entries);
  assert.match(report, /Change Journal/);
  assert.match(report, /write_file/);
  assert.match(report, /test\.js/);
});

test("formatJournalReport for empty entries", () => {
  isolateHome();
  const report = formatJournalReport([]);
  assert.match(report, /No journal entries/);
});

test("undo removes journal entry after undoing", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "test.js");
  fs.writeFileSync(file, "original");
  const id = journalChange("ses_1", "write_file", [{ path: "test.js", absPath: file }]);
  flushJournal();
  assert.equal(listJournal().length, 1);
  undoChange(id);
  assert.equal(listJournal().length, 0);
});

test("journal handles multiple files in one entry", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file1 = path.join(dir, "a.js");
  const file2 = path.join(dir, "b.js");
  fs.writeFileSync(file1, "content a");
  fs.writeFileSync(file2, "content b");
  journalChange("ses_1", "copy_path", [
    { path: "a.js", absPath: file1 },
    { path: "b.js", absPath: file2 }
  ]);
  flushJournal();
  const entries = listJournal();
  assert.equal(entries[0].changes.length, 2);
  assert.equal(entries[0].changes[0].backup.content, "content a");
  assert.equal(entries[0].changes[1].backup.content, "content b");
});

test("large file backup is truncated", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "big.js");
  const bigContent = "x".repeat(maxBackupBytes() + 1000);
  fs.writeFileSync(file, bigContent);
  journalChange("ses_1", "write_file", [{ path: "big.js", absPath: file }]);
  flushJournal();
  const entries = listJournal();
  assert.equal(entries[0].changes[0].backup.truncated, true);
  assert.ok(entries[0].changes[0].backup.size > maxBackupBytes());
});

test("truncated backup undo returns error", () => {
  isolateHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ws-"));
  const file = path.join(dir, "big.js");
  const bigContent = "x".repeat(maxBackupBytes() + 1000);
  fs.writeFileSync(file, bigContent);
  const id = journalChange("ses_1", "write_file", [{ path: "big.js", absPath: file }]);
  flushJournal();
  fs.writeFileSync(file, "changed");
  const result = undoChange(id);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].includes("truncated"));
});
