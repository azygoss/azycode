import { execFileSync } from "node:child_process";

import { formatAgentRunReport } from "./harness.js";
import { formatTodoList, listTodos } from "./todos.js";

export function collectChangedFiles(cwd = process.cwd()) {
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.slice(3).trim().replace(/^"|"$/g, ""));
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