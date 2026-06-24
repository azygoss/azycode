import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileCancellable } from "./exec.js";
import { assertPatchPathsAllowed } from "./path-guard.js";
import { evaluateShellPolicy } from "./shell-risk.js";
import { isGitRepository, prepareSubagentWorkspace } from "./subagents.js";

export async function validatePatch({
  cwd = process.cwd(),
  patch,
  checks = [],
  cfg = {},
  timeoutMs = 120_000,
  signal = null
} = {}) {
  if (!patch || !String(patch).trim()) {
    return reportFailure("Patch content is required.");
  }

  const root = path.resolve(cwd);

  // Guard the patch destinations before doing any work: a patch touching a
  // protected path (e.g. .env, .github/workflows/) must be rejected even when
  // it would otherwise apply cleanly in the worktree.
  try {
    assertPatchPathsAllowed(root, String(patch), cfg);
  } catch (error) {
    return reportFailure(error.message);
  }

  if (!isGitRepository(root)) {
    return validatePatchWithoutWorktree(root, patch);
  }

  const sessionId = `patch-${Date.now()}`;
  const workspace = prepareSubagentWorkspace({
    cfg: { subagentIsolation: "worktree" },
    cwd: root,
    agentName: "validation",
    sessionId
  });

  if (workspace.isolation !== "worktree") {
    return validatePatchWithoutWorktree(root, patch);
  }

  const patchFile = path.join(os.tmpdir(), `azycode-validate-patch-${process.pid}-${Date.now()}.diff`);
  fs.writeFileSync(patchFile, String(patch), "utf8");
  const startedAt = Date.now();

  try {
    execFileSync("git", ["apply", "--check", patchFile], {
      cwd: workspace.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    execFileSync("git", ["apply", patchFile], {
      cwd: workspace.cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    const changedFiles = listChangedFiles(workspace.cwd);
    const checkResults = await runPatchChecks(workspace.cwd, checks, { timeoutMs, signal, cfg });
    const ok = checkResults.every((entry) => entry.ok);
    return {
      ok,
      mode: "worktree",
      worktree: workspace.worktree?.path || workspace.cwd,
      changedFiles,
      checks: checkResults,
      durationMs: Date.now() - startedAt,
      error: ok ? null : checkResults.find((entry) => !entry.ok)?.error || "Patch validation failed."
    };
  } catch (error) {
    return {
      ok: false,
      mode: "worktree",
      worktree: workspace.worktree?.path || workspace.cwd,
      changedFiles: [],
      checks: [],
      durationMs: Date.now() - startedAt,
      error: error.message
    };
  } finally {
    fs.rmSync(patchFile, { force: true });
    await workspace.cleanup();
  }
}

function validatePatchWithoutWorktree(root, patch) {
  const patchFile = path.join(os.tmpdir(), `azycode-validate-patch-${process.pid}-${Date.now()}.diff`);
  fs.writeFileSync(patchFile, String(patch), "utf8");
  try {
    execFileSync("git", ["apply", "--check", patchFile], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    return {
      ok: true,
      mode: "check-only",
      worktree: null,
      changedFiles: [],
      checks: [],
      durationMs: 0,
      error: null,
      note: "Patch applies cleanly (check-only; no isolated worktree available)."
    };
  } catch (error) {
    return reportFailure(error.message, { mode: "check-only" });
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

async function runPatchChecks(cwd, checks, { timeoutMs, signal, cfg = {} }) {
  const entries = Array.isArray(checks) ? checks.filter(Boolean) : [];
  if (!entries.length) return [];
  const results = [];
  for (const command of entries) {
    const startedAt = Date.now();
    // Enforce shell policy on each check command so a destructive or
    // secret-exfiltrating command in a patch's checks cannot run unchecked.
    const policy = evaluateShellPolicy(command, cfg);
    if (policy.decision === "deny") {
      results.push({
        command,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        error: `Denied by shell policy: ${policy.reason}`,
        output: ""
      });
      continue;
    }
    try {
      const { stdout, stderr, code } = await execFileCancellable(process.env.SHELL || "sh", ["-lc", command], {
        cwd,
        timeout: timeoutMs,
        signal,
        maxBuffer: 1024 * 1024 * 4
      });
      results.push({
        command,
        ok: code === 0,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        output: [stdout, stderr].filter(Boolean).join("\n").trim().slice(0, 2000)
      });
      if (code !== 0) {
        results[results.length - 1].error = `Command exited with code ${code}`;
      }
    } catch (error) {
      results.push({
        command,
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        error: error.message,
        output: ""
      });
    }
  }
  return results;
}

function gitOutput(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function listChangedFiles(cwd) {
  const tracked = gitOutput(["diff", "--name-only", "HEAD"], cwd).split("\n").filter(Boolean);
  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard"], cwd).split("\n").filter(Boolean);
  return [...new Set([...tracked, ...untracked])].sort();
}

function reportFailure(error, extra = {}) {
  return {
    ok: false,
    mode: extra.mode || "none",
    worktree: null,
    changedFiles: [],
    checks: [],
    durationMs: 0,
    error
  };
}

export function formatPatchValidationReport(report) {
  const lines = [
    "Patch Validation",
    `ok: ${report.ok ? "yes" : "no"}`,
    `mode: ${report.mode}`
  ];
  if (report.worktree) lines.push(`worktree: ${report.worktree}`);
  if (report.note) lines.push(`note: ${report.note}`);
  if (report.changedFiles?.length) lines.push(`changedFiles: ${report.changedFiles.join(", ")}`);
  if (report.durationMs) lines.push(`durationMs: ${report.durationMs}`);
  if (report.error) lines.push(`error: ${report.error}`);
  if (report.checks?.length) {
    lines.push("checks:");
    for (const check of report.checks) {
      lines.push(`- ${check.command}: ${check.ok ? "ok" : "failed"} (${check.durationMs || 0}ms)`);
      if (check.error) lines.push(`  error: ${check.error}`);
      if (check.output) lines.push(`  output: ${check.output}`);
    }
  }
  return lines.join("\n");
}