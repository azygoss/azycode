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

export function formatSubagentResults(results = [], { json = false } = {}) {
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