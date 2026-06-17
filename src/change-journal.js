/** Change journal with undo support for filesystem tool calls. Zero-dependency. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { azyHome, ensureHome, id } from "./config.js";
import { debug, warn } from "./logger.js";

const MAX_JOURNAL_ENTRIES = 500;
const MAX_BACKUP_BYTES = 50_000;
const JOURNAL_VERSION = 1;

let _journalCache = null;
let _journalMtime = 0;
let _pendingChanges = [];

function journalPath() {
  return path.join(azyHome(), "journal.json");
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function loadJournal() {
  ensureHome();
  const jPath = journalPath();
  const mtime = fileMtime(jPath);
  if (_journalCache && _journalMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_journalCache) : JSON.parse(JSON.stringify(_journalCache));
  }
  try {
    const data = JSON.parse(fs.readFileSync(jPath, "utf8"));
    const normalized = {
      version: data.version || JOURNAL_VERSION,
      entries: Array.isArray(data.entries) ? data.entries : []
    };
    _journalCache = normalized;
    _journalMtime = mtime;
    return typeof structuredClone === "function" ? structuredClone(normalized) : JSON.parse(JSON.stringify(normalized));
  } catch (error) {
    if (error.code === "ENOENT") return { version: JOURNAL_VERSION, entries: [] };
    throw error;
  }
}

export function saveJournal(journal) {
  ensureHome();
  const tmp = `${journalPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(journal, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, journalPath());
  _journalCache = null;
  _journalMtime = 0;
}

/**
 * Back up file content before a mutation. Returns null if file doesn't exist.
 * @private
 */
function backupFile(absPath) {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return null;
    const content = fs.readFileSync(absPath);
    if (content.length > MAX_BACKUP_BYTES) {
      const hash = crypto.createHash("sha256").update(content).digest("hex");
      return { backedUp: true, truncated: true, size: stat.size, hash, content: content.subarray(0, MAX_BACKUP_BYTES).toString("utf8") };
    }
    return { backedUp: true, truncated: false, size: stat.size, content: content.toString("utf8") };
  } catch (error) {
    if (error.code === "ENOENT") return { backedUp: false, existed: false };
    debug(`Could not back up ${absPath}: ${error.message}`);
    return null;
  }
}

/**
 * Record a journal entry for one or more file changes.
 * @param {string} sessionId - Agent session ID
 * @param {string} tool - Tool name (write_file, edit_file, delete_path, etc.)
 * @param {Array<{path: string, absPath: string}>} files - Affected files
 * @returns {string|null} Journal entry ID or null if journaling is disabled/no files
 */
export function journalChange(sessionId, tool, files) {
  if (!files || files.length === 0) return null;

  const entry = {
    id: id("chg"),
    sessionId: sessionId ? String(sessionId) : null,
    tool: String(tool),
    at: new Date().toISOString(),
    changes: files.map((f) => {
      const backup = backupFile(f.absPath);
      return {
        path: f.path,
        absPath: f.absPath,
        backup
      };
    })
  };

  _pendingChanges.push(entry);
  flushPendingChanges(false);

  return entry.id;
}

function flushPendingChanges(force = false) {
  if (_pendingChanges.length === 0) return;

  try {
    const journal = loadJournal();
    journal.entries.push(..._pendingChanges);
    _pendingChanges = [];

    if (journal.entries.length > MAX_JOURNAL_ENTRIES) {
      journal.entries = journal.entries.slice(-MAX_JOURNAL_ENTRIES);
    }
    saveJournal(journal);
    debug(`Journal flushed ${journal.entries.length} total entries`);
  } catch (error) {
    debug(`Journal flush failed: ${error.message}`);
  }
}

export function flushJournal() {
  flushPendingChanges(true);
}

/**
 * List journal entries.
 * @param {{sessionId?: string, limit?: number, tool?: string}} options
 */
export function listJournal({ sessionId = null, limit = 50, tool = null } = {}) {
  flushJournal();
  const journal = loadJournal();
  let entries = [...journal.entries].reverse();

  if (sessionId) {
    entries = entries.filter((entry) => entry.sessionId === sessionId);
  }
  if (tool) {
    entries = entries.filter((entry) => entry.tool === tool);
  }

  const maxLimit = Math.max(1, Math.min(500, Number(limit) || 50));
  return entries.slice(0, maxLimit);
}

/**
 * Undo a single journal entry by restoring backed-up file contents.
 * @param {string} journalId - Journal entry ID
 * @returns {{ok: boolean, restored: string[], errors: string[], entry: object|null}}
 */
export function undoChange(journalId) {
  flushJournal();
  const journal = loadJournal();
  const entryIndex = journal.entries.findIndex((entry) => entry.id === journalId);
  if (entryIndex === -1) {
    return { ok: false, restored: [], errors: [`Journal entry not found: ${journalId}`], entry: null };
  }

  const entry = journal.entries[entryIndex];
  const restored = [];
  const errors = [];

  for (const change of entry.changes) {
    try {
      if (entry.tool === "delete_path" && change.backup?.existed === false) {
        if (fs.existsSync(change.absPath)) {
          fs.rmSync(change.absPath, { force: true });
          restored.push(`deleted (was newly created): ${change.path}`);
        } else {
          restored.push(`already absent: ${change.path}`);
        }
        continue;
      }

      if (!change.backup || !change.backup.backedUp) {
        if (fs.existsSync(change.absPath)) {
          fs.rmSync(change.absPath, { force: true });
          restored.push(`removed (had no backup): ${change.path}`);
        } else {
          restored.push(`already absent: ${change.path}`);
        }
        continue;
      }

      if (change.backup.truncated) {
        errors.push(`cannot fully restore (backup truncated): ${change.path}`);
        continue;
      }

      const dir = path.dirname(change.absPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(change.absPath, change.backup.content, "utf8");
      restored.push(`restored: ${change.path}`);
    } catch (error) {
      errors.push(`${change.path}: ${error.message}`);
    }
  }

  journal.entries.splice(entryIndex, 1);
  saveJournal(journal);

  return {
    ok: errors.length === 0,
    restored,
    errors,
    entry: { id: entry.id, tool: entry.tool, sessionId: entry.sessionId, at: entry.at }
  };
}

/**
 * Undo all journal entries for a session, newest first.
 * @param {string} sessionId
 * @returns {{ok: boolean, undone: number, restored: string[], errors: string[]}}
 */
export function undoSession(sessionId) {
  flushJournal();
  const journal = loadJournal();
  const sessionEntries = journal.entries
    .filter((entry) => entry.sessionId === sessionId)
    .map((entry) => entry.id);

  if (sessionEntries.length === 0) {
    return { ok: false, undone: 0, restored: [], errors: [`No journal entries found for session: ${sessionId}`] };
  }

  const allRestored = [];
  const allErrors = [];
  let undone = 0;

  for (const entryId of sessionEntries) {
    const result = undoChange(entryId);
    allRestored.push(...result.restored);
    allErrors.push(...result.errors);
    undone += 1;
  }

  return {
    ok: allErrors.length === 0,
    undone,
    restored: allRestored,
    errors: allErrors
  };
}

/**
 * Clear all journal entries.
 * @returns {number} Number of entries removed
 */
export function clearJournal() {
  const journal = loadJournal();
  const count = journal.entries.length;
  saveJournal({ version: JOURNAL_VERSION, entries: [] });
  _pendingChanges = [];
  return count;
}

export function formatJournalReport(entries) {
  if (!entries.length) return "No journal entries.";
  const lines = ["Change Journal", `entries: ${entries.length}`, ""];
  for (const entry of entries) {
    const files = entry.changes.map((c) => c.path).join(", ");
    const sessionTag = entry.sessionId ? ` [${entry.sessionId}]` : "";
    lines.push(`${entry.id}${sessionTag} ${entry.tool}: ${files}`);
    lines.push(`  ${faintTime(entry.at)}`);
  }
  return lines.join("\n");
}

function faintTime(isoString) {
  return String(isoString || "");
}

export function maxJournalEntries() {
  return MAX_JOURNAL_ENTRIES;
}

export function maxBackupBytes() {
  return MAX_BACKUP_BYTES;
}
