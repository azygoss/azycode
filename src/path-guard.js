import path from "node:path";
import fs from "node:fs";

const DEFAULT_PROTECTED_PATTERNS = [
  { pattern: /^\.git(?:\/|$)/, reason: ".git metadata is protected" },
  { pattern: /^\.env(?:\.|$)/, reason: ".env files may contain secrets" },
  { pattern: /^node_modules(?:\/|$)/, reason: "node_modules is protected" },
  { pattern: /^(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb)$/, reason: "lockfiles are protected by default" },
  { pattern: /^\.npmrc$/, reason: "package manager config may contain tokens" },
  { pattern: /^\.pypirc$/, reason: "PyPI config may contain tokens" },
  { pattern: /^\.github\/workflows\//, reason: "CI workflows are security-sensitive" },
  { pattern: /^\.azycode\/config\.json$/, reason: "harness config is protected" }
];

/**
 * Normalize a requested path against the workspace root.
 *
 * Performs a lexical containment check and, when `options.resolveSymlinks`
 * is set, also resolves the real path on disk so symlinks cannot be used to
 * escape the workspace. This mirrors the defense used by hardened tool layers
 * (path traversal via `ln -s /etc/passwd etc-passwd` must be blocked).
 */
export function normalizeWorkspacePath(root, requested, options = {}) {
  const resolved = path.resolve(root, requested || ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `Path escapes workspace: ${requested}` };
  }

  // Lexical containment passed. If requested, also resolve symlinks so an
  // attacker cannot place a symlink inside the workspace that points outside.
  if (options.resolveSymlinks) {
    try {
      const realRoot = fs.realpathSync(root);
      let realTarget = resolved;
      try {
        // realpathSync resolves the final target if the file exists.
        realTarget = fs.realpathSync(resolved);
      } catch {
        // Target may not exist yet (write path). Walk the existing prefix and
        // resolve any symlinked ancestors to detect escape before creation.
        realTarget = resolveExistingAncestors(resolved);
      }
      const realRel = path.relative(realRoot, realTarget);
      if (realRel.startsWith("..") || path.isAbsolute(realRel)) {
        return { ok: false, reason: `Symlink escapes workspace: ${requested}` };
      }
    } catch (err) {
      // If realpath of root itself fails we cannot make a containment claim;
      // fail closed.
      return { ok: false, reason: `Unable to resolve workspace root: ${err && err.message}` };
    }
  }

  return { ok: true, rel: rel.split(path.sep).join("/") || ".", abs: resolved };
}

/** Resolve the longest existing prefix of `target`, following symlinks. */
function resolveExistingAncestors(target) {
  let probe = target;
  const failed = [];
  while (true) {
    try {
      return fs.realpathSync(probe);
    } catch {
      const dir = path.dirname(probe);
      if (dir === probe) {
        // Reached the filesystem root without a resolvable component.
        return target;
      }
      failed.unshift(path.basename(probe));
      probe = dir;
    }
  }
}

export function isProtectedWritePath(relPath, cfg = {}) {
  const normalized = String(relPath || "").replace(/\\/g, "/");
  const allowLockfiles = Boolean(cfg.pathGuard?.allowLockfiles);
  const allowEnv = Boolean(cfg.pathGuard?.allowEnv);
  const allowCi = Boolean(cfg.pathGuard?.allowCiWorkflows);
  const extra = Array.isArray(cfg.pathGuard?.protected) ? cfg.pathGuard.protected : [];

  for (const { pattern, reason } of DEFAULT_PROTECTED_PATTERNS) {
    if (allowLockfiles && /lock/.test(pattern.source)) continue;
    if (allowEnv && /\.env/.test(pattern.source)) continue;
    if (allowCi && /workflows/.test(pattern.source)) continue;
    if (pattern.test(normalized)) {
      return { protected: true, reason, path: normalized };
    }
  }
  for (const item of extra) {
    const pat = String(item || "").replace(/\\/g, "/");
    if (!pat) continue;
    if (normalized === pat || normalized.startsWith(`${pat}/`)) {
      return { protected: true, reason: `Protected by pathGuard.protected: ${pat}`, path: normalized };
    }
  }
  return { protected: false, path: normalized };
}

/**
 * Evaluate whether a write to `requested` is allowed, combining workspace
 * containment ({@link normalizeWorkspacePath}) with the protected-path list
 * ({@link isProtectedWritePath}).
 *
 * Returns `{ allowed: true }` for ordinary paths, `{ allowed: false }` when the
 * path escapes the workspace, or `{ allowed: null, requiresApproval: true }`
 * for protected paths that need explicit approval (config may auto-allow).
 *
 * @param {string} root - Workspace root.
 * @param {string} requested - Path requested by the model (relative or absolute).
 * @param {object} [cfg={}] - Active config (pathGuard options).
 * @param {object} [options={}] - `{ resolveSymlinks, bypassPathGuard, approved }`.
 * @returns {{allowed:boolean|null, path:string, reason:string, requiresApproval?:boolean}}
 */
export function evaluateWritePath(root, requested, cfg = {}, options = {}) {
  const norm = normalizeWorkspacePath(root, requested, { resolveSymlinks: options.resolveSymlinks });
  if (!norm.ok) return { allowed: false, reason: norm.reason, path: requested };

  const check = isProtectedWritePath(norm.rel, cfg);
  if (!check.protected) {
    return { allowed: true, path: norm.rel, reason: "path not protected" };
  }

  const bypass = Boolean(options.bypassPathGuard || cfg.pathGuard?.disabled);
  const alwaysAllow = Boolean(cfg.pathGuard?.allowProtected);
  if (bypass || alwaysAllow) {
    return { allowed: true, path: norm.rel, reason: `${check.reason} (explicitly allowed by config)` };
  }

  const profile = cfg.permissionProfile || "normal";
  if (profile === "full-auto" && cfg.pathGuard?.autoApproveProtected) {
    return { allowed: true, path: norm.rel, reason: `${check.reason} (full-auto with pathGuard.autoApproveProtected)` };
  }

  return {
    allowed: null,
    path: norm.rel,
    reason: check.reason,
    requiresApproval: true
  };
}

export function assertWritePathAllowed(root, requested, cfg, options = {}) {
  const result = evaluateWritePath(root, requested, cfg, options);
  if (result.allowed === false) throw new Error(result.reason);
  if (result.allowed === null && !options.approved) {
    throw new Error(`Write to protected path blocked: ${result.path} — ${result.reason}. Explicit approval required.`);
  }
  return result;
}

export function listProtectedPathPatterns(cfg = {}) {
  return DEFAULT_PROTECTED_PATTERNS.map((item) => ({
    pattern: item.pattern.source,
    reason: item.reason,
    active: true
  }));
}

/** Extract destination paths from a unified diff (b/ side). */
export function extractUnifiedDiffPaths(patch) {
  const paths = new Set();
  for (const line of String(patch || "").split(/\r?\n/)) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) {
      if (gitMatch[2] !== "/dev/null") paths.add(gitMatch[2]);
      continue;
    }
    const plusMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (plusMatch && plusMatch[1] !== "/dev/null") paths.add(plusMatch[1]);
  }
  return [...paths];
}

export function assertPatchPathsAllowed(root, patch, cfg, options = {}) {
  const paths = extractUnifiedDiffPaths(patch);
  for (const relPath of paths) {
    assertWritePathAllowed(root, relPath, cfg, options);
  }
  return paths;
}