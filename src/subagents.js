import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { loadConfig, saveConfig } from "./config.js";

export const SUBAGENT_ISOLATION_MODES = ["same-workspace", "worktree"];

export function listSubagents(cfg) {
  return Object.entries(cfg.subagents || {}).map(([name, agent]) => ({ name, ...agent }));
}

export function resolveSubagentIsolation(cfg = loadConfig()) {
  const mode = cfg.subagentIsolation || "same-workspace";
  return SUBAGENT_ISOLATION_MODES.includes(mode) ? mode : "same-workspace";
}

export function isGitRepository(cwd) {
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export function prepareSubagentWorkspace({
  cfg = loadConfig(),
  cwd = process.cwd(),
  agentName,
  sessionId = "session"
} = {}) {
  const isolation = resolveSubagentIsolation(cfg);
  if (isolation !== "worktree" || !isGitRepository(cwd)) {
    return { cwd, isolation: "same-workspace", worktree: null, cleanup: async () => {} };
  }

  const safeAgent = String(agentName || "agent").replace(/[^a-zA-Z0-9_-]/g, "-");
  const safeSession = String(sessionId || "session").replace(/[^a-zA-Z0-9_-]/g, "-");
  const root = path.resolve(cwd);
  const worktreeRoot = path.join(root, ".azycode", "worktrees", safeSession);
  const target = path.join(worktreeRoot, safeAgent);
  const branch = `azycode/subagent/${safeSession}/${safeAgent}`;
  fs.mkdirSync(worktreeRoot, { recursive: true });

  try {
    execFileSync("git", ["worktree", "add", "-B", branch, target], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    return {
      cwd: root,
      isolation: "same-workspace",
      worktree: null,
      cleanup: async () => {},
      warning: error.message
    };
  }

  return {
    cwd: target,
    isolation: "worktree",
    worktree: { path: target, branch, sessionId: safeSession, agent: safeAgent },
    cleanup: async () => {
      try {
        execFileSync("git", ["worktree", "remove", target, "--force"], {
          cwd: root,
          stdio: "ignore"
        });
      } catch {
        // Best-effort cleanup.
      }
    }
  };
}

export function collectSubagentChangedFiles(workspaceCwd, baseCwd = workspaceCwd) {
  const cwd = path.resolve(workspaceCwd);
  const root = path.resolve(baseCwd);
  try {
    if (cwd === root) {
      const out = execFileSync("git", ["status", "--short"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      return out.split("\n").filter(Boolean).map((line) => {
        const parts = line.trim().split(/\s+/);
        const file = parts[parts.length - 1];
        return file.includes("->") ? file.split("->").pop().trim() : file;
      });
    }
    const out = execFileSync("git", ["diff", "--name-only"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function inferSubagentVerification(task = {}, changedFiles = []) {
  const prompt = String(task.prompt || "").toLowerCase();
  const checks = [];
  if (/npm test|node --test|pnpm test|yarn test/.test(prompt)) checks.push("npm test");
  if (/npm run check/.test(prompt)) checks.push("npm run check");
  if (/lint/.test(prompt)) checks.push("npm run lint");
  if (!checks.length && changedFiles.some((file) => /\.(js|mjs|cjs|ts|tsx)$/.test(file))) {
    checks.push("npm test");
  }
  return checks;
}

export function assessSubagentConfidence({ ok, changedFiles = [], durationMs = 0, error = "" } = {}) {
  if (!ok) return "low";
  if (error) return "low";
  if (!changedFiles.length) return "medium";
  if (durationMs > 120_000) return "medium";
  return "high";
}

export function addSubagent({ name, description, system, model = null, reasoning = "medium" }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(name)) {
    throw new Error("Subagent name must start with a letter and contain only letters, numbers, _ or -.");
  }
  if (name.length > 64) throw new Error("Subagent name must be at most 64 characters.");
  if (description && String(description).length > 200) throw new Error("Subagent description must be at most 200 characters.");
  if (system && String(system).length > 10000) throw new Error("Subagent system prompt must be at most 10000 characters.");
  const cfg = loadConfig();
  cfg.subagents ||= {};
  cfg.subagents[name] = { description, system, model, reasoning };
  saveConfig(cfg);
  return cfg.subagents[name];
}

export function removeSubagent(name) {
  const cfg = loadConfig();
  if (!cfg.subagents?.[name]) throw new Error(`No subagent named ${name}.`);
  delete cfg.subagents[name];
  saveConfig(cfg);
}

export async function runSubagentsParallel({
  cfg,
  cwd,
  tasks = [],
  signal = null,
  maxParallel = 4,
  maxStepsPerAgent = 8,
  subagentDepth = 0,
  onSubagentEvent = null,
  sessionId = null
} = {}) {
  const limit = Math.max(1, Math.min(8, Number(maxParallel) || 4));
  const allTasks = Array.isArray(tasks) ? tasks : [];
  const maxDepth = Number.isFinite(Number(cfg.maxSubagentDepth))
    ? Math.max(0, Math.floor(Number(cfg.maxSubagentDepth)))
    : 2;
  if (subagentDepth >= maxDepth) {
    return allTasks.map((task, index) => ({
      index: index + 1,
      agent: task?.agent,
      ok: false,
      error: `Subagent nesting depth limit (${maxDepth}) reached.`,
      durationMs: 0,
      changedFiles: [],
      verification: [],
      confidence: "low",
      isolation: resolveSubagentIsolation(cfg)
    }));
  }
  const results = [];
  const runSessionId = sessionId || `run-${Date.now()}`;
  for (let offset = 0; offset < allTasks.length; offset += limit) {
    const batch = allTasks.slice(offset, offset + limit);
    const batchResults = await Promise.all(batch.map(async (task, batchIndex) => {
      const index = offset + batchIndex + 1;
      const agentName = task?.agent;
      const profile = cfg.subagents?.[agentName];
      if (!profile) {
        return {
          index,
          agent: agentName,
          ok: false,
          error: `Unknown subagent: ${agentName}`,
          durationMs: 0,
          changedFiles: [],
          verification: [],
          confidence: "low",
          isolation: resolveSubagentIsolation(cfg)
        };
      }
      const startedAt = Date.now();
      const workspace = prepareSubagentWorkspace({
        cfg,
        cwd,
        agentName,
        sessionId: `${runSessionId}-${index}`
      });
      onSubagentEvent?.({
        type: "subagent_start",
        agent: agentName,
        index,
        prompt: task.prompt,
        isolation: workspace.isolation,
        worktree: workspace.worktree?.path || null
      });
      try {
        // Subagents must not silently escalate privileges. They inherit the
        // parent's permission profile and tool policy rather than forcing
        // alwaysApprove on. The parent cfg already encodes the intended trust
        // level (e.g. via permissionProfile / toolPolicy).
        const output = await runAgent({
          cfg,
          cwd: workspace.cwd,
          prompt: String(task.prompt || ""),
          mode: task.mode || "always-approve",
          subagent: { name: agentName, ...profile },
          maxSteps: Number(task.maxSteps) > 0 ? Number(task.maxSteps) : maxStepsPerAgent,
          signal,
          // Propagate the incremented depth so recursive subagents converge on
          // the maxSubagentDepth limit instead of nesting unboundedly.
          subagentDepth: subagentDepth + 1,
          progressStyle: "tui"
        });
        const changedFiles = collectSubagentChangedFiles(workspace.cwd, cwd);
        const result = {
          index,
          agent: agentName,
          ok: true,
          output: String(output),
          durationMs: Date.now() - startedAt,
          changedFiles,
          verification: inferSubagentVerification(task, changedFiles),
          confidence: assessSubagentConfidence({ ok: true, changedFiles, durationMs: Date.now() - startedAt }),
          isolation: workspace.isolation,
          worktree: workspace.worktree?.path || null,
          warning: workspace.warning || null
        };
        onSubagentEvent?.({ type: "subagent_end", ...result });
        return result;
      } catch (error) {
        const changedFiles = collectSubagentChangedFiles(workspace.cwd, cwd);
        const result = {
          index,
          agent: agentName,
          ok: false,
          error: error.message,
          output: error.partialContent || "",
          durationMs: Date.now() - startedAt,
          changedFiles,
          verification: inferSubagentVerification(task, changedFiles),
          confidence: "low",
          isolation: workspace.isolation,
          worktree: workspace.worktree?.path || null,
          warning: workspace.warning || null
        };
        onSubagentEvent?.({ type: "subagent_end", ...result });
        return result;
      } finally {
        await workspace.cleanup();
      }
    }));
    results.push(...batchResults);
  }
  return results;
}

/**
 * Aggregate parallel subagent results into a supervisor-style summary suitable
 * for parent-agent handoff or CLI reporting.
 */
export function aggregateSubagentResults(results = []) {
  const items = Array.isArray(results) ? results : [];
  const succeeded = items.filter((r) => r.ok);
  const failed = items.filter((r) => !r.ok);
  const changedFiles = [...new Set(items.flatMap((r) => r.changedFiles || []))].sort();
  const verification = [...new Set(items.flatMap((r) => r.verification || []))];
  const totalDurationMs = items.reduce((sum, r) => sum + (Number(r.durationMs) || 0), 0);
  const confidences = items.map((r) => r.confidence || (r.ok ? "medium" : "low"));
  const confidenceRollup = failed.length
    ? "low"
    : confidences.includes("low")
      ? "low"
      : confidences.includes("medium")
        ? "medium"
        : "high";
  const worktrees = items.filter((r) => r.worktree).map((r) => ({ agent: r.agent, path: r.worktree }));
  const nextSteps = [];
  if (failed.length) {
    nextSteps.push(`Retry failed subagents: ${failed.map((r) => r.agent).join(", ")}`);
  }
  if (changedFiles.length && verification.length) {
    nextSteps.push(`Run verification: ${verification.join(", ")}`);
  } else if (changedFiles.length) {
    nextSteps.push("Review changed files before merging supervisor results.");
  }
  if (!failed.length && items.length > 1) {
    nextSteps.push("Supervisor run complete — integrate subagent outputs into parent plan.");
  }

  return {
    total: items.length,
    succeeded: succeeded.length,
    failed: failed.length,
    ok: failed.length === 0,
    totalDurationMs,
    confidence: confidenceRollup,
    changedFiles,
    verification,
    worktrees,
    nextSteps,
    agents: items.map((r) => ({
      index: r.index,
      agent: r.agent,
      ok: Boolean(r.ok),
      durationMs: r.durationMs ?? 0,
      confidence: r.confidence || (r.ok ? "medium" : "low"),
      changedFiles: r.changedFiles || [],
      error: r.error || null,
      isolation: r.isolation || "same-workspace"
    })),
    brief: buildSupervisorBrief({ items, succeeded, failed, changedFiles, verification, confidenceRollup, totalDurationMs })
  };
}

export function buildSupervisorBrief({
  items = [],
  succeeded = [],
  failed = [],
  changedFiles = [],
  verification = [],
  confidenceRollup = "medium",
  totalDurationMs = 0
} = {}) {
  const lines = [
    `Supervisor summary: ${succeeded.length}/${items.length} subagents succeeded (${totalDurationMs}ms total, confidence: ${confidenceRollup}).`
  ];
  if (changedFiles.length) {
    lines.push(`Changed files (${changedFiles.length}): ${changedFiles.slice(0, 24).join(", ")}${changedFiles.length > 24 ? "…" : ""}`);
  }
  if (verification.length) {
    lines.push(`Suggested verification: ${verification.join(", ")}`);
  }
  for (const result of failed) {
    lines.push(`FAILED [${result.agent}]: ${result.error || "unknown error"}`);
  }
  for (const result of succeeded) {
    const preview = String(result.output || "").trim().split("\n").slice(0, 3).join(" ").slice(0, 200);
    if (preview) lines.push(`OK [${result.agent}]: ${preview}${preview.length >= 200 ? "…" : ""}`);
  }
  return lines.join("\n");
}

export function formatSupervisorSummary(aggregate, { json = false } = {}) {
  if (json) return JSON.stringify(aggregate, null, 2);
  return aggregate?.brief || buildSupervisorBrief();
}

export function formatSubagentResults(results = [], { json = false, supervisor = false } = {}) {
  if (supervisor) {
    const aggregate = aggregateSubagentResults(results);
    if (json) {
      return JSON.stringify({ supervisor: aggregate, results }, null, 2);
    }
    return `${formatSupervisorSummary(aggregate)}\n\n${formatSubagentResults(results)}`;
  }
  if (json) return JSON.stringify(results, null, 2);
  return results.map((result) => {
    const status = result.ok ? "ok" : "failed";
    const header = [
      `## Subagent ${result.index}: ${result.agent} (${status})`,
      `duration: ${result.durationMs ?? 0}ms`,
      `isolation: ${result.isolation || "same-workspace"}`,
      result.worktree ? `worktree: ${result.worktree}` : null,
      `confidence: ${result.confidence || (result.ok ? "medium" : "low")}`,
      result.changedFiles?.length ? `changedFiles: ${result.changedFiles.join(", ")}` : "changedFiles: (none)",
      result.verification?.length ? `verification: ${result.verification.join(", ")}` : null,
      result.warning ? `warning: ${result.warning}` : null
    ].filter(Boolean).join("\n");
    const body = result.ok
      ? (result.output || "(no output)")
      : `ERROR: ${result.error}\n${result.output || ""}`.trim();
    return `${header}\n${body}`;
  }).join("\n\n");
}