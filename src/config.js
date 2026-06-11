import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { defaultSubagents } from "./prompts.js";
import { applyPermissionProfile as applyProfile, PERMISSION_PROFILES } from "./permissions.js";
import { defaultSandboxConfig } from "./execution-policy.js";

export const DEFAULT_MODE = "build";
export const MODES = ["plan", "build", "always-approve", "goal", "review"];
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
    toolTimeoutMs: 120_000,
    maxInRunMessages: 80,
    maxConversationMessages: 40,
    compaction: "trim",
    maxParallelSubagents: 4,
    subagentMaxSteps: 8,
    maxSubagentDepth: 2,
    streamResponses: false,
    mcpServers: {},
    hooks: {},
    gitGuard: {
      enabled: true,
      blockBranches: ["main", "master"],
      requireClean: false
    },
    pathGuard: {
      allowLockfiles: false,
      allowEnv: false,
      allowCiWorkflows: false,
      autoApproveProtected: false,
      protected: []
    },
    shellPolicy: {
      allowDestructive: false,
      autoNetwork: false,
      autoBuildTest: true,
      redactSecrets: true
    },
    sandbox: defaultSandboxConfig(),
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
      git_commit: "ask",
      web_fetch: "ask",
      spawn_subagents: "ask",
      git_worktree: "ask",
      todo: "auto",
      set_mode: "auto"
    }
  };
}

export const COMPACTION_MODES = ["trim", "llm"];

export { defaultSubagents };

const KNOWN_TOOL_NAMES = new Set([
  "list_files", "read_file", "read_many_files", "file_info", "search",
  "make_dir", "write_file", "edit_file", "copy_path", "move_path", "delete_path",
  "apply_patch", "git_diff", "git_status", "git_log", "git_show", "git_checkout", "git_commit",
  "web_fetch", "spawn_subagents", "git_worktree", "shell", "todo", "set_mode"
]);
const KNOWN_PROFILES = new Set(PERMISSION_PROFILES);

let _configCache = null;
let _configMtime = 0;
let _stateCache = null;
let _stateMtime = 0;
let _todosCache = null;
let _todosMtime = 0;

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function validateConfig(cfg) {
  const defaults = defaultConfig();
  cfg.mode = normalizeMode(cfg.mode);
  if (!MODES.includes(cfg.mode)) {
    cfg.mode = defaults.mode;
  }
  if (!REASONING_LEVELS.includes(cfg.reasoning)) {
    cfg.reasoning = defaults.reasoning;
  }
  if (!KNOWN_PROFILES.has(cfg.permissionProfile)) {
    cfg.permissionProfile = defaults.permissionProfile;
  }
  if (!COMPACTION_MODES.includes(cfg.compaction)) {
    cfg.compaction = defaults.compaction;
  }
  const maxParallel = Number(cfg.maxParallelSubagents);
  cfg.maxParallelSubagents = Number.isFinite(maxParallel) && maxParallel > 0
    ? Math.min(8, Math.floor(maxParallel))
    : defaults.maxParallelSubagents;
  const subagentSteps = Number(cfg.subagentMaxSteps);
  cfg.subagentMaxSteps = Number.isFinite(subagentSteps) && subagentSteps > 0
    ? Math.floor(subagentSteps)
    : defaults.subagentMaxSteps;
  const subagentDepth = Number(cfg.maxSubagentDepth);
  cfg.maxSubagentDepth = Number.isFinite(subagentDepth) && subagentDepth >= 0
    ? Math.min(8, Math.floor(subagentDepth))
    : defaults.maxSubagentDepth;
  const policy = cfg.toolPolicy || {};
  for (const key of Object.keys(policy)) {
    if (!KNOWN_TOOL_NAMES.has(key)) {
      delete policy[key];
    } else if (!["auto", "ask", "deny"].includes(policy[key])) {
      policy[key] = "ask";
    }
  }
  cfg.providers ||= {};
  cfg.subagents ||= {};
  cfg.skills ||= {};
  cfg.gitGuard ||= { ...defaults.gitGuard };
  cfg.pathGuard = { ...defaults.pathGuard, ...(cfg.pathGuard || {}) };
  cfg.shellPolicy = { ...defaults.shellPolicy, ...(cfg.shellPolicy || {}) };
  cfg.sandbox = { ...defaults.sandbox, ...(cfg.sandbox || {}) };
  return cfg;
}

export function loadConfig() {
  ensureHome();
  const cPath = configPath();
  const mtime = fileMtime(cPath);
  if (_configCache && _configMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_configCache) : JSON.parse(JSON.stringify(_configCache));
  }
  const defaults = defaultConfig();
  const saved = readJson(cPath, {});
  const cfg = { ...defaults, ...saved };
  cfg.providers ||= {};
  cfg.subagents = { ...defaults.subagents, ...(saved.subagents || {}) };
  cfg.skills = { ...defaults.skills, ...(saved.skills || {}) };
  cfg.gitGuard = { ...defaults.gitGuard, ...(saved.gitGuard || {}) };
  if (saved.gitGuard && Object.prototype.hasOwnProperty.call(saved.gitGuard, "enabled")) {
    cfg.gitGuard.enabled = saved.gitGuard.enabled;
  }
  cfg.pathGuard = { ...defaults.pathGuard, ...(saved.pathGuard || {}) };
  cfg.shellPolicy = { ...defaults.shellPolicy, ...(saved.shellPolicy || {}) };
  cfg.sandbox = { ...defaults.sandbox, ...(saved.sandbox || {}) };
  const savedToolPolicy = saved.toolPolicy || {};
  cfg.toolPolicy = { ...defaults.toolPolicy };
  cfg.mcpServers = { ...defaults.mcpServers, ...(saved.mcpServers || {}) };
  validateConfig(cfg);
  applyPermissionProfile(cfg);
  cfg.toolPolicy = { ...cfg.toolPolicy, ...savedToolPolicy };
  for (const key of Object.keys(cfg.toolPolicy)) {
    if (!KNOWN_TOOL_NAMES.has(key)) delete cfg.toolPolicy[key];
    else if (!["auto", "ask", "deny"].includes(cfg.toolPolicy[key])) cfg.toolPolicy[key] = "ask";
  }
  _configCache = cfg;
  _configMtime = mtime;
  return typeof structuredClone === "function" ? structuredClone(cfg) : JSON.parse(JSON.stringify(cfg));
}

export function saveConfig(cfg) {
  ensureHome();
  const tmp = `${configPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, configPath());
  _configCache = null;
  _configMtime = 0;
}

export function loadState() {
  ensureHome();
  const sPath = statePath();
  const mtime = fileMtime(sPath);
  if (_stateCache && _stateMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_stateCache) : JSON.parse(JSON.stringify(_stateCache));
  }
  const state = readJson(sPath, { version: 1, sessions: {}, goals: {}, missions: {}, toolRuns: [] });
  state.sessions ||= {};
  state.goals ||= {};
  state.missions ||= {};
  state.toolRuns ||= [];
  _stateCache = state;
  _stateMtime = mtime;
  return typeof structuredClone === "function" ? structuredClone(state) : JSON.parse(JSON.stringify(state));
}

export function saveState(state) {
  ensureHome();
  const tmp = `${statePath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, statePath());
  _stateCache = null;
  _stateMtime = 0;
}

/** Atomic read-modify-write with fresh disk read (bypasses stale cache). */
export function updateState(mutator, { retries = 4 } = {}) {
  ensureHome();
  const sPath = statePath();
  const defaults = { version: 1, sessions: {}, goals: {}, missions: {}, toolRuns: [] };
  let lastError = null;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    _stateCache = null;
    _stateMtime = 0;
    const beforeMtime = fileMtime(sPath);
    const state = readJson(sPath, defaults);
    state.sessions ||= {};
    state.goals ||= {};
    state.missions ||= {};
    state.toolRuns ||= [];
    try {
      const next = mutator(state) ?? state;
      next.version = (Number(next.version) || 0) + 1;
      if (beforeMtime !== fileMtime(sPath)) continue;
      saveState(next);
      return next;
    } catch (error) {
      lastError = error;
      if (attempt === retries - 1) throw error;
    }
  }
  throw lastError || new Error("updateState failed");
}

export function loadTodos() {
  const tPath = todosPath();
  const mtime = fileMtime(tPath);
  if (_todosCache && _todosMtime === mtime) {
    return typeof structuredClone === "function" ? structuredClone(_todosCache) : JSON.parse(JSON.stringify(_todosCache));
  }
  const todos = readJson(tPath, {});
  _todosCache = todos;
  _todosMtime = mtime;
  return typeof structuredClone === "function" ? structuredClone(todos) : JSON.parse(JSON.stringify(todos));
}

export function saveTodos(todos) {
  ensureHome();
  const tmp = `${todosPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(todos, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, todosPath());
  _todosCache = null;
  _todosMtime = 0;
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
  if (mode === "approve") return "always-approve";
  if (mode === "normal") return "build";
  return mode;
}

export function rotateReasoning(current) {
  const index = REASONING_LEVELS.indexOf(current);
  return REASONING_LEVELS[(index + 1) % REASONING_LEVELS.length] || "medium";
}

export function applyPermissionProfile(cfg) {
  return applyProfile(cfg);
}
