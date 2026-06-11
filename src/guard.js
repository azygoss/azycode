import { execFileSync } from "node:child_process";

export function resolveGitGuard(cfg = {}) {
  const guard = cfg.gitGuard || {};
  const enabled = guard.enabled !== false;
  return {
    enabled,
    blockBranches: guard.blockBranches ?? ["main", "master"],
    requireClean: Boolean(guard.requireClean)
  };
}

export function gitGuard(cwd = process.cwd(), cfg = {}) {
  const guard = resolveGitGuard(cfg);
  if (!guard.enabled) {
    return {
      ok: true,
      enabled: false,
      warnings: [],
      hint: "Git guard is disabled. Run `azycode config set guard enabled true` to re-enable branch protection."
    };
  }
  const warnings = [];
  const branch = git(["branch", "--show-current"], cwd).trim();
  const status = git(["status", "--short"], cwd).trim();
  if (guard.blockBranches.includes(branch)) {
    return {
      ok: false,
      enabled: true,
      branch,
      reason: `Current branch '${branch}' is blocked by gitGuard.blockBranches.`,
      hint: "Use `git_checkout` with create:true on a feature branch, or disable with `azycode config set guard enabled false`."
    };
  }
  if (guard.requireClean && status) {
    return {
      ok: false,
      enabled: true,
      branch,
      reason: "Working tree is not clean and gitGuard.requireClean is enabled.",
      hint: "Commit or stash changes, or run `azycode config set guard require-clean false`."
    };
  }
  if (!branch) warnings.push("No current git branch detected (detached HEAD or not a git repository).");
  return {
    ok: true,
    enabled: true,
    branch,
    dirty: Boolean(status),
    warnings,
    hint: "Protected branches (main/master) block writes and shell. Checkout a feature branch to edit."
  };
}

export function formatGuard(result) {
  if (result.ok) {
    const parts = ["git guard: ok"];
    if (result.enabled === false) parts.push("enabled=false");
    if (result.branch) parts.push(`branch=${result.branch}`);
    if (result.dirty) parts.push("dirty=true");
    for (const warning of result.warnings || []) parts.push(`warning=${warning}`);
    if (result.hint && result.enabled === false) parts.push(`hint=${result.hint}`);
    return parts.join(" ");
  }
  const lines = [`git guard: blocked: ${result.reason}`];
  if (result.hint) lines.push(`hint: ${result.hint}`);
  return lines.join(" ");
}

export function formatGuardJson(result) {
  return {
    ok: result.ok,
    enabled: result.enabled !== false,
    branch: result.branch || null,
    dirty: Boolean(result.dirty),
    reason: result.reason || null,
    warnings: result.warnings || [],
    hint: result.hint || null
  };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

/** Branch names safe for git checkout -b / checkout. */
export function validateBranchName(name) {
  const branch = String(name || "").trim();
  if (!branch || branch.includes("..") || branch.startsWith("-") || /[\s\x00@:~?*[\]^]/.test(branch)) {
    throw new Error("Invalid branch name.");
  }
  return branch;
}
