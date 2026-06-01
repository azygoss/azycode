import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export const DEFAULT_MODE = "plan";
export const MODES = ["plan", "always-approve", "goal", "review"];
export const REASONING_LEVELS = ["minimal", "low", "medium", "high"];

export function azyHome() {
  return process.env.AZYCODE_HOME || path.join(os.homedir(), ".azycode");
}

export function configPath() {
  return path.join(azyHome(), "config.json");
}

export function statePath() {
  return path.join(azyHome(), "state.json");
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
    permissionProfile: "normal",
    gitGuard: {
      enabled: true,
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
      git_diff: "auto"
    }
  };
}

export function defaultSubagents() {
  return {
    planner: {
      description: "Breaks a coding request into scoped implementation steps.",
      model: null,
      reasoning: "high",
      system: "You are a planning subagent. Produce a concise, ordered implementation plan with risks and verification steps."
    },
    reviewer: {
      description: "Reviews code changes for bugs, regressions, missing tests, and risky assumptions.",
      model: null,
      reasoning: "high",
      system: "You are a strict code review subagent. Lead with defects and cite files or commands when possible."
    },
    implementer: {
      description: "Implements scoped coding tasks using the available filesystem and shell tools.",
      model: null,
      reasoning: "medium",
      system: "You are a pragmatic coding subagent. Make narrow changes, verify them, and report what changed."
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
