import path from "node:path";

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

export function normalizeWorkspacePath(root, requested) {
  const resolved = path.resolve(root, requested || ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, reason: `Path escapes workspace: ${requested}` };
  }
  return { ok: true, rel: rel.split(path.sep).join("/") || ".", abs: resolved };
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

export function evaluateWritePath(root, requested, cfg = {}, options = {}) {
  const norm = normalizeWorkspacePath(root, requested);
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