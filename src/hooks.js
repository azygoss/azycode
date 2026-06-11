import fs from "node:fs";
import path from "node:path";
import { azyHome } from "./config.js";
import { execFileCancellable } from "./exec.js";

export const HOOK_EVENTS = [
  "agent_run_start",
  "agent_run_end",
  "pre_model",
  "post_model",
  "pre_tool",
  "post_tool"
];

let _hookCacheKey = "";
let _hookCacheValue = null;

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function hookCacheKey(cfg, cwd) {
  const globalFile = path.join(azyHome(), "hooks.json");
  const projectFile = path.join(path.resolve(cwd), ".azycode", "hooks.json");
  return [
    fileMtime(globalFile),
    fileMtime(projectFile),
    JSON.stringify(cfg.hooks || {})
  ].join("|");
}

export function loadHookConfig(cfg, cwd = process.cwd()) {
  const key = hookCacheKey(cfg, cwd);
  if (_hookCacheKey === key && _hookCacheValue) {
    return _hookCacheValue;
  }
  const merged = {};
  const sources = [
    path.join(azyHome(), "hooks.json"),
    path.join(path.resolve(cwd), ".azycode", "hooks.json"),
    cfg.hooks || {}
  ];
  for (const source of sources) {
    const block = typeof source === "string" ? readJson(source) : source;
    if (!block || typeof block !== "object") continue;
    for (const event of HOOK_EVENTS) {
      if (!Array.isArray(block[event])) continue;
      merged[event] = [...(merged[event] || []), ...block[event]];
    }
  }
  _hookCacheKey = key;
  _hookCacheValue = merged;
  return merged;
}

export function clearHookConfigCache() {
  _hookCacheKey = "";
  _hookCacheValue = null;
}

export async function runHooks(event, payload, hooks = {}, { cwd = process.cwd(), signal = null } = {}) {
  const handlers = hooks[event] || [];
  let current = { ...payload };
  for (const handler of handlers) {
    const result = await invokeHook(handler, event, current, { cwd, signal });
    if (result?.block) {
      const error = new Error(result.message || `Hook blocked ${event}`);
      error.code = "hook_blocked";
      throw error;
    }
    if (result?.modify && typeof result.modify === "object") {
      current = { ...current, ...result.modify };
    }
  }
  return current;
}

async function invokeHook(handler, event, payload, { cwd, signal }) {
  const command = typeof handler === "string" ? handler : handler?.command;
  if (!command) return null;
  const args = Array.isArray(handler?.args) ? handler.args : [];
  const timeout = Number(handler?.timeoutMs) > 0 ? Number(handler.timeoutMs) : 10_000;
  const env = {
    ...process.env,
    AZYCODE_HOOK_EVENT: event,
    AZYCODE_HOOK_CWD: cwd,
    ...(handler?.env || {})
  };
  const shell = process.env.SHELL || "sh";
  const script = `exec ${JSON.stringify(command)} ${args.map((arg) => JSON.stringify(String(arg))).join(" ")}`;
  const { stdout } = await execFileCancellable(shell, ["-lc", script], {
    cwd,
    timeout,
    maxBuffer: 1024 * 1024,
    signal,
    env: { ...env, AZYCODE_HOOK_PAYLOAD: JSON.stringify(payload) }
  });
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}