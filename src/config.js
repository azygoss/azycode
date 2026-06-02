import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_MODE = "plan";
export const MODES = ["plan", "always-approve", "goal", "review"];
export const REASONING_LEVELS = ["minimal", "low", "medium", "high"];

/** Returns a positive step cap, or null for unlimited agent runs (default). */
export function resolveAgentMaxSteps(cfg, override) {
  const unlimitedTokens = new Set(["", "unlimited", "none", "off", "false", "0", "null"]);
  const parse = (value) => {
    if (value === undefined || value === null) return undefined;
    const raw = String(value).trim().toLowerCase();
    if (unlimitedTokens.has(raw)) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.floor(parsed);
  };

  const direct = parse(override);
  if (override !== undefined && override !== null && override !== "") return direct;

  const env = parse(process.env.AZYCODE_AGENT_MAX_STEPS);
  if (process.env.AZYCODE_AGENT_MAX_STEPS !== undefined) return env;

  if (cfg && Object.prototype.hasOwnProperty.call(cfg, "agentMaxSteps")) {
    return parse(cfg.agentMaxSteps);
  }

  return null;
}

export function formatAgentStepLimit(limit) {
  return limit ? `max ${limit} steps` : "unlimited steps";
}

export function azyHome() {
  return process.env.AZYCODE_HOME || path.join(os.homedir(), ".azycode");
}

export function configPath() {
  return path.join(azyHome(), "config.json");
}

export function statePath() {
  return path.join(azyHome(), "state.json");
}

export function todosPath() {
  return path.join(azyHome(), "todos.json");
}

export function ensureHome() {
  fs.mkdirSync(azyHome(), { recursive: true, mode: 0o700 });
}

export function defaultConfig() {
  return {
    version: 1,
    activeProvider: null,
    activeModel: null,
    mode: DEFAULT_MODE,
    alwaysApprove: false,
    reasoning: "medium",
    providers: {},
    subagents: defaultSubagents(),
    skills: {},
    permissionProfile: "normal",
    gitGuard: {
      enabled: false,
      blockBranches: ["main", "master"],
      requireClean: false
    },
    toolPolicy: {
      read_file: "auto",
      read_many_files: "auto",
      file_info: "auto",
      list_files: "auto",
      search: "auto",
      git_status: "auto",
      git_log: "auto",
      git_show: "auto",
      shell: "ask",
      make_dir: "ask",
      write_file: "ask",
      edit_file: "ask",
      copy_path: "ask",
      move_path: "ask",
      delete_path: "ask",
      apply_patch: "ask",
      git_diff: "auto",
      git_checkout: "auto",
      todo: "auto",
      set_mode: "auto"
    }
  };
}

export function defaultSubagents() {
  return {
    planner: {
      description: "Breaks a coding request into scoped implementation steps.",
      model: null,
      reasoning: "high",
      system: [
        "You are Azycode's planning subagent.",
        "Inspect only the context needed to understand the repository shape, relevant files, constraints, and risk.",
        "Produce a concise ordered plan with implementation steps, expected file areas, verification commands, and risks.",
        "Do not modify files. If the request is ambiguous, state the smallest concrete assumption that keeps work moving."
      ].join("\n")
    },
    reviewer: {
      description: "Reviews code changes for bugs, regressions, missing tests, and risky assumptions.",
      model: null,
      reasoning: "high",
      system: [
        "You are Azycode's strict code review subagent.",
        "Inspect diffs, touched files, and relevant tests before concluding.",
        "Lead with actionable findings ordered by severity. Cite file paths, functions, commands, or evidence.",
        "Prioritize correctness bugs, regressions, security issues, data loss risk, missing tests, and misleading UX.",
        "If no issues are found, say so clearly and list any residual risk or unrun checks."
      ].join("\n")
    },
    implementer: {
      description: "Implements scoped coding tasks using the available filesystem and shell tools.",
      model: null,
      reasoning: "medium",
      system: [
        "You are Azycode's pragmatic implementation subagent.",
        "Inspect before editing, keep changes narrow, and preserve local style.",
        "Use built-in tools for repository work: bounded read/search for context, apply_patch/edit/write for changes, and shell only for relevant verification.",
        "After edits, run focused checks when available and report changed files plus verification results.",
        "Do not leave half-applied work or claim success without evidence."
      ].join("\n")
    }
  };
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function loadConfig() {
  ensureHome();
  const defaults = defaultConfig();
  const saved = readJson(configPath(), {});
  const cfg = { ...defaults, ...saved };
  cfg.providers ||= {};
  cfg.subagents = { ...defaults.subagents, ...(saved.subagents || {}) };
  cfg.skills = { ...defaults.skills, ...(saved.skills || {}) };
  cfg.gitGuard = { ...defaults.gitGuard, ...(saved.gitGuard || {}) };
  cfg.toolPolicy = { ...defaults.toolPolicy, ...(saved.toolPolicy || {}) };
  applyPermissionProfile(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  ensureHome();
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath());
}

export function loadState() {
  ensureHome();
  const state = readJson(statePath(), { version: 1, sessions: {}, goals: {}, missions: {}, toolRuns: [] });
  state.sessions ||= {};
  state.goals ||= {};
  state.missions ||= {};
  state.toolRuns ||= [];
  return state;
}

export function saveState(state) {
  ensureHome();
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath());
}

export function loadTodos() {
  return readJson(todosPath(), {});
}

export function saveTodos(todos) {
  ensureHome();
  const tmp = `${todosPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(todos, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, todosPath());
}

export function maskSecret(value) {
  if (!value) return "";
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export function rotateMode(current) {
  if (current === "approve") current = "always-approve";
  const index = MODES.indexOf(current);
  return MODES[(index + 1) % MODES.length] || DEFAULT_MODE;
}

export function normalizeMode(mode) {
  return mode === "approve" ? "always-approve" : mode;
}

export function rotateReasoning(current) {
  const index = REASONING_LEVELS.indexOf(current);
  return REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length] || "medium";
}

export function applyPermissionProfile(cfg) {
  const profile = cfg.permissionProfile || "normal";
  if (profile === "read-only") {
    cfg.toolPolicy = { ...cfg.toolPolicy, write_file: "deny", edit_file: "deny", apply_patch: "deny", shell: "deny" };
  } else if (profile === "safe-write") {
    cfg.toolPolicy = { ...cfg.toolPolicy, write_file: "ask", edit_file: "ask", apply_patch: "ask", shell: "ask" };
  } else if (profile === "full-auto") {
    cfg.toolPolicy = { ...cfg.toolPolicy, write_file: "auto", edit_file: "auto", apply_patch: "auto", shell: "auto" };
  }
  return cfg;
}
