import { execFileSync } from "node:child_process";

export function gitGuard(cwd = process.cwd(), cfg = {}) {
  const guard = cfg.gitGuard || {};
  if (guard.enabled === false) return { ok: true, warnings: [] };
  const warnings = [];
  const branch = git(["branch", "--show-current"], cwd).trim();
  const status = git(["status", "--short"], cwd).trim();
  if (guard.blockBranches?.includes(branch)) {
    return { ok: false, reason: `Current branch '${branch}' is blocked by gitGuard.blockBranches.` };
  }
  if (guard.requireClean && status) {
    return { ok: false, reason: "Working tree is not clean and gitGuard.requireClean is enabled." };
  }
  if (!branch) warnings.push("No current git branch detected (detached HEAD or not a git repository).");
  return { ok: true, branch, dirty: Boolean(status), warnings };
}

export function formatGuard(result) {
  if (result.ok) {
    const parts = ["git guard: ok"];
    if (result.branch) parts.push(`branch=${result.branch}`);
    if (result.dirty) parts.push("dirty=true");
    for (const warning of result.warnings || []) parts.push(`warning=${warning}`);
    return parts.join(" ");
  }
  return `git guard: blocked: ${result.reason}`;
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
