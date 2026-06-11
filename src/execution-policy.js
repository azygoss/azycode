import os from "node:os";
import path from "node:path";
import { classifyShellCommand } from "./shell-risk.js";

const DEFAULT_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "npm_config_cache", "npm_config_prefix", "CI", "TMPDIR", "TMP", "TEMP",
  "PWD", "OLDPWD", "AZYCODE_HOME"
];

const SECRET_ENV_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/i;

export function defaultSandboxConfig() {
  return {
    mode: "local",
    network: "ask",
    readonlyRoot: false,
    mounts: [],
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: 120_000,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 8 * 1024 * 1024
  };
}

export function resolveExecutionPolicy(cfg = {}, cwd = process.cwd()) {
  const sandbox = { ...defaultSandboxConfig(), ...(cfg.sandbox || {}) };
  const shellPolicy = cfg.shellPolicy || {};
  return {
    cwd: path.resolve(cwd),
    mode: sandbox.mode || "local",
    network: sandbox.network || "ask",
    readonlyRoot: Boolean(sandbox.readonlyRoot),
    mounts: Array.isArray(sandbox.mounts) ? sandbox.mounts : [],
    envAllowlist: Array.isArray(sandbox.envAllowlist) ? sandbox.envAllowlist : DEFAULT_ENV_ALLOWLIST,
    timeoutMs: Number(sandbox.timeoutMs) || 120_000,
    maxStdoutBytes: Number(sandbox.maxStdoutBytes) || 8 * 1024 * 1024,
    maxStderrBytes: Number(sandbox.maxStderrBytes) || 8 * 1024 * 1024,
    shellPolicy,
    redactSecrets: shellPolicy.redactSecrets !== false
  };
}

export function filterEnv(env = process.env, allowlist = DEFAULT_ENV_ALLOWLIST) {
  const allowed = new Set(allowlist.map((k) => String(k)));
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key) && !SECRET_ENV_PATTERN.test(key)) out[key] = value;
  }
  return out;
}

export function redactCommand(command) {
  return String(command || "")
    .replace(/(?:api[_-]?key|token|secret|password|bearer)\s*[=:]\s*['"]?[^\s'"]+/gi, (match) => match.replace(/[=:]\s*['"]?[^\s'"]+/i, "=***"))
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, "sk-***")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer ***");
}

export function prepareShellCommand(command, policy) {
  const classification = classifyShellCommand(command);
  const shell = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : (process.env.SHELL || "sh");
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", command]
    : ["-lc", command];

  return {
    file: shell,
    args,
    cwd: policy.cwd,
    env: filterEnv(process.env, policy.envAllowlist),
    timeout: policy.timeoutMs,
    maxBuffer: policy.maxStdoutBytes,
    classification,
    logCommand: policy.redactSecrets ? redactCommand(command) : command,
    backend: policy.mode
  };
}

export function describeExecutionPolicy(policy) {
  return {
    mode: policy.mode,
    network: policy.network,
    readonlyRoot: policy.readonlyRoot,
    cwd: policy.cwd,
    envAllowlistCount: policy.envAllowlist.length,
    timeoutMs: policy.timeoutMs,
    maxStdoutBytes: policy.maxStdoutBytes,
    redactSecrets: policy.redactSecrets
  };
}

export function buildContainerArgs(policy, { runtime = "docker", command } = {}) {
  const binary = runtime === "podman" ? "podman" : "docker";
  const args = ["run", "--rm", "-i"];
  if (policy.network === "deny") args.push("--network", "none");
  if (policy.readonlyRoot) args.push("--read-only");
  args.push("-w", "/workspace", "-v", `${policy.cwd}:/workspace`);
  for (const mount of policy.mounts) {
    if (mount?.source && mount?.target) args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
  }
  if (process.platform !== "win32") {
    args.push("--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  }
  const image = policy.image || "node:20-alpine";
  args.push(image, "sh", "-lc", command);
  return { binary, args, image };
}

export function resolveShellInvocation(command, cfg, cwd) {
  const policy = resolveExecutionPolicy(cfg, cwd);
  const prepared = prepareShellCommand(command, policy);
  if (policy.mode === "none") {
    return { ...prepared, blocked: true, reason: "sandbox.mode=none disables shell execution" };
  }
  if (policy.mode === "docker" || policy.mode === "podman") {
    const container = buildContainerArgs(policy, { runtime: policy.mode, command });
    return { ...prepared, container, useContainer: true };
  }
  return { ...prepared, useContainer: false };
}