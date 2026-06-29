import { execFileSync } from "node:child_process";

import { formatAgentRunReport, summarizeAgentRun } from "./harness.js";
import { formatTodoList, listActiveTodos, listTodos } from "./todos.js";
import { listJournal } from "./change-journal.js";
import { searchMemory } from "./memory.js";

export function parseGitStatusPaths(line) {
  const raw = String(line || "");
  if (raw.length < 4) return null;
  // short/porcelain: XY<space>path — never trim the line start (X may be a space).
  const pathPart = raw.slice(3).trim();
  if (!pathPart) return null;
  const resolved = pathPart.includes("->") ? pathPart.split("->").pop().trim() : pathPart;
  return resolved.replace(/^"|"$/g, "");
}

export function collectChangedFiles(cwd = process.cwd()) {
  try {
    const out = execFileSync("git", ["status", "--short"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out
      .split("\n")
      .map(parseGitStatusPaths)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function buildStepLimitReport({
  maxSteps,
  events = [],
  partialContent = "",
  cwd = process.cwd(),
  style = "tui"
} = {}) {
  const report = formatAgentRunReport(events, { maxSteps, style });
  const openTodos = listTodos(cwd, { status: ["pending", "in_progress"] });
  const completedTodos = listTodos(cwd, { status: "completed" });
  const changed = collectChangedFiles(cwd);

  const sections = [
    `Agent stopped after ${maxSteps} steps without a final answer.`,
    "The model kept requesting tools instead of returning a closing message.",
    "",
    "Steps in this run:",
    report || "  (no steps recorded)"
  ];

  if (partialContent) {
    sections.push("", "Partial assistant response:", partialContent);
  }

  if (openTodos.length) {
    sections.push("", "Incomplete todos:", formatTodoList(openTodos));
  }

  if (completedTodos.length) {
    sections.push("", "Completed todos:", formatTodoList(completedTodos.slice(-8)));
  }

  if (changed.length) {
    sections.push("", "Changed files:", changed.map((file) => `- ${file}`).join("\n"));
  }

  sections.push("", "Try: simplify the task, use /compact, or remove agentMaxSteps from config for unlimited runs.");
  return sections.join("\n");
}

export function appendOpenTodosNotice(content, cwd = process.cwd()) {
  const openTodos = listTodos(cwd, { status: ["pending", "in_progress"] });
  if (!openTodos.length) return String(content || "");
  const body = String(content || "").trim();
  const notice = `Open todos remain:\n${formatTodoList(openTodos)}`;
  return body ? `${body}\n\n${notice}` : notice;
}

/**
 * Build a durable handoff artifact for long-horizon goal runs. Captures todos,
 * changed files, journal activity, memory hits, and session stats so a resumed
 * goal or supervisor can pick up with full context.
 */
export function buildGoalHandoffArtifact({
  goal = {},
  cwd = process.cwd(),
  events = [],
  sessionId = null,
  partialContent = ""
} = {}) {
  const openTodos = listActiveTodos(cwd, { sessionId });
  const completedTodos = listTodos(cwd, { status: "completed" }).slice(-12);
  const changed = collectChangedFiles(cwd);
  const stats = summarizeAgentRun(events);
  const journalEntries = listJournal({ sessionId, limit: 12 });
  const memoryHits = searchMemory(String(goal.text || "").slice(0, 120)).slice(0, 6);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    goal: {
      text: goal.text || "",
      status: goal.status || "",
      startedAt: goal.startedAt || null,
      finishedAt: goal.finishedAt || null,
      sessions: goal.sessions || []
    },
    sessionId,
    stats: {
      steps: stats.steps || 0,
      toolCalls: stats.toolCalls || 0,
      durationMs: stats.durationMs || 0,
      tokens: stats.tokens || 0,
      status: stats.status || "unknown"
    },
    todos: {
      open: openTodos,
      completed: completedTodos
    },
    changedFiles: changed,
    journal: journalEntries.slice(-8),
    memory: memoryHits.map((item) => ({ id: item.id, text: item.text, tags: item.tags })),
    partialContent: String(partialContent || "").slice(0, 4000),
    resumePrompt: buildGoalResumePrompt(goal, { openTodos, changed, stats })
  };
}

export function buildGoalResumePrompt(goal, { openTodos = [], changed = [], stats = {} } = {}) {
  const parts = [
    `Continue this goal until complete: ${goal.text || "(no goal text)"}`,
    openTodos.length ? `Open todos:\n${formatTodoList(openTodos)}` : null,
    changed.length ? `Changed files: ${changed.join(", ")}` : null,
    stats.steps ? `Prior run: ${stats.steps} steps, ${stats.toolCalls || 0} tool calls.` : null
  ].filter(Boolean);
  return parts.join("\n\n");
}

export function formatGoalHandoffArtifact(artifact, { json = false } = {}) {
  if (json) return JSON.stringify(artifact, null, 2);
  const lines = [
    `Goal handoff (${artifact.goal?.status || "unknown"})`,
    `Goal: ${artifact.goal?.text || ""}`,
    `Session: ${artifact.sessionId || "(none)"}`,
    `Steps: ${artifact.stats?.steps || 0} · Tools: ${artifact.stats?.toolCalls || 0} · ${artifact.stats?.durationMs || 0}ms`,
    artifact.changedFiles?.length ? `Changed: ${artifact.changedFiles.join(", ")}` : "Changed: (none)",
    artifact.todos?.open?.length ? `Open todos:\n${formatTodoList(artifact.todos.open)}` : null,
    artifact.partialContent ? `Partial output:\n${artifact.partialContent}` : null
  ].filter(Boolean);
  return lines.join("\n\n");
}