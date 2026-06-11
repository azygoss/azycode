/** Central permission profile and tool policy resolver. */

export const PERMISSION_PROFILES = [
  "normal",
  "read-only",
  "plan-only",
  "safe-write",
  "trusted-workspace",
  "full-auto"
];

export const TOOL_CATEGORIES = {
  read: new Set([
    "list_files", "read_file", "read_many_files", "file_info", "search",
    "git_diff", "git_status", "git_log", "git_show"
  ]),
  write: new Set([
    "make_dir", "write_file", "edit_file", "copy_path", "move_path",
    "delete_path", "apply_patch"
  ]),
  shell: new Set(["shell"]),
  network: new Set(["web_fetch"]),
  git: new Set(["git_checkout", "git_diff", "git_status", "git_log", "git_show", "git_commit", "git_worktree"]),
  mcp: new Set(), // populated dynamically; prefix mcp_ or from catalog
  subagent: new Set(["spawn_subagents"]),
  meta: new Set(["todo", "set_mode"])
};

const PROFILE_DEFAULTS = {
  normal: {
    read: "auto",
    write: "ask",
    shell: "ask",
    network: "ask",
    git: "auto",
    mcp: "ask",
    subagent: "ask"
  },
  "read-only": {
    read: "auto",
    write: "deny",
    shell: "deny",
    network: "deny",
    git: "auto",
    mcp: "deny",
    subagent: "deny"
  },
  "plan-only": {
    read: "auto",
    write: "deny",
    shell: "deny",
    network: "deny",
    git: "auto",
    mcp: "deny",
    subagent: "deny"
  },
  "safe-write": {
    read: "auto",
    write: "ask",
    shell: "ask",
    network: "ask",
    git: "auto",
    mcp: "ask",
    subagent: "ask"
  },
  "trusted-workspace": {
    read: "auto",
    write: "auto",
    shell: "auto",
    network: "ask",
    git: "auto",
    mcp: "ask",
    subagent: "ask"
  },
  "full-auto": {
    read: "auto",
    write: "auto",
    shell: "auto",
    network: "auto",
    git: "auto",
    mcp: "auto",
    subagent: "auto"
  }
};

export function toolCategory(toolName) {
  const name = String(toolName || "");
  if (TOOL_CATEGORIES.read.has(name)) return "read";
  if (TOOL_CATEGORIES.write.has(name)) return "write";
  if (TOOL_CATEGORIES.shell.has(name)) return "shell";
  if (TOOL_CATEGORIES.network.has(name)) return "network";
  if (TOOL_CATEGORIES.git.has(name)) return "git";
  if (TOOL_CATEGORIES.subagent.has(name)) return "subagent";
  if (TOOL_CATEGORIES.meta.has(name)) return "meta";
  if (name.startsWith("mcp_") || name.includes("__")) return "mcp";
  return "meta";
}

export function profileCategoryPolicy(profile, category) {
  const defaults = PROFILE_DEFAULTS[profile] || PROFILE_DEFAULTS.normal;
  return defaults[category] || "ask";
}

export function buildProfileToolPolicy(profile) {
  const overrides = {};
  for (const [category, tools] of Object.entries(TOOL_CATEGORIES)) {
    const rule = profileCategoryPolicy(profile, category);
    for (const tool of tools) overrides[tool] = rule;
  }
  const writeRule = profileCategoryPolicy(profile, "write");
  overrides.git_commit = writeRule;
  overrides.git_worktree = writeRule;
  return overrides;
}

/** Apply profile defaults onto cfg.toolPolicy. Saved per-tool overrides are merged in loadConfig after this runs. */
export function applyPermissionProfile(cfg) {
  const profile = cfg.permissionProfile || "normal";
  if (!PERMISSION_PROFILES.includes(profile)) {
    cfg.permissionProfile = "normal";
  }
  cfg.toolPolicy = { ...buildProfileToolPolicy(cfg.permissionProfile) };
  return cfg;
}

export function resolveToolPermission(cfg, toolName, context = {}) {
  const name = String(toolName || "");
  const category = toolCategory(name);
  const profile = cfg.permissionProfile || "normal";
  const explicit = cfg.toolPolicy?.[name];
  const profileRule = profileCategoryPolicy(profile, category);
  const rule = explicit ?? profileRule;
  const alwaysApprove = Boolean(cfg.alwaysApprove || cfg.mode === "always-approve");

  let decision = rule;
  let reason = `profile=${profile} category=${category} rule=${rule}`;

  if (rule === "deny") {
    return { allowed: false, decision: "deny", rule, reason: `${reason}; tool denied by policy` };
  }
  if (alwaysApprove && rule !== "deny") {
    return { allowed: true, decision: "auto", rule, reason: `${reason}; alwaysApprove=true` };
  }
  if (rule === "auto") {
    return { allowed: true, decision: "auto", rule, reason };
  }
  if (context.sessionApproval === true) {
    return { allowed: true, decision: "ask", rule, reason: `${reason}; session-scoped approval granted` };
  }
  return { allowed: null, decision: "ask", rule, reason: `${reason}; approval required` };
}

export function describePermissionProfile(profile) {
  const defaults = PROFILE_DEFAULTS[profile] || PROFILE_DEFAULTS.normal;
  return {
    profile,
    categories: { ...defaults },
    description: profileDescription(profile)
  };
}

function profileDescription(profile) {
  switch (profile) {
    case "read-only":
      return "Read and inspect only; writes, shell, and network are denied.";
    case "plan-only":
      return "Planning mode; same as read-only — no mutations.";
    case "safe-write":
      return "Reads auto-approve; writes, shell, and network require approval.";
    case "trusted-workspace":
      return "Auto-approve reads and writes in a trusted workspace; network still asks.";
    case "full-auto":
      return "Auto-approve all tool categories; git guard and path protections still apply.";
    default:
      return "Balanced defaults: reads auto, risky tools ask.";
  }
}