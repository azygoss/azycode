import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { classifyShellCommand } from "./shell-risk.js";
import { execFileCancellable } from "./exec.js";
import { info, warn } from "./logger.js";

export const SANDBOX_MODES = ["local", "docker", "podman", "none"];
export const SANDBOX_NETWORK_MODES = ["deny", "ask", "allow"];
export const SANDBOX_FALLBACK_MODES = ["local", "none"];

const DEFAULT_ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "NODE_ENV", "npm_config_cache", "npm_config_prefix", "CI", "TMPDIR", "TMP", "TEMP",
  "PWD", "OLDPWD", "AZYCODE_HOME"
];

const SECRET_ENV_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|PRIVATE)/i;
const SECRET_OUTPUT_PATTERN = /(?:api[_-]?key|token|secret|password|bearer)\s*[=:]\s*['"]?[^\s'"]+|sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[a-zA-Z0-9._-]+/gi;

export function defaultSandboxConfig() {
  return {
    mode: "local",
    network: "deny",
    readonlyRoot: false,
    mounts: [],
    envAllowlist: [...DEFAULT_ENV_ALLOWLIST],
    timeoutMs: 120_000,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 2 * 1024 * 1024,
    image: "node:20-alpine",
    fallbackMode: "local",
    passEnv: true
  };
}

export function resolveExecutionPolicy(cfg = {}, cwd = process.cwd()) {
  const sandbox = { ...defaultSandboxConfig(), ...(cfg.sandbox || {}) };
  const shellPolicy = cfg.shellPolicy || {};
  const mode = SANDBOX_MODES.includes(sandbox.mode) ? sandbox.mode : "local";
  const network = SANDBOX_NETWORK_MODES.includes(sandbox.network) ? sandbox.network : "deny";
  const fallbackMode = SANDBOX_FALLBACK_MODES.includes(sandbox.fallbackMode) ? sandbox.fallbackMode : "local";
  return {
    cwd: path.resolve(cwd),
    mode,
    network,
    readonlyRoot: Boolean(sandbox.readonlyRoot),
    mounts: Array.isArray(sandbox.mounts) ? sandbox.mounts : [],
    envAllowlist: Array.isArray(sandbox.envAllowlist) ? sandbox.envAllowlist : DEFAULT_ENV_ALLOWLIST,
    timeoutMs: Number(sandbox.timeoutMs) || 120_000,
    maxStdoutBytes: Number(sandbox.maxStdoutBytes) || 8 * 1024 * 1024,
    maxStderrBytes: Number(sandbox.maxStderrBytes) || 2 * 1024 * 1024,
    image: String(sandbox.image || "node:20-alpine"),
    fallbackMode,
    passEnv: sandbox.passEnv !== false,
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

export function redactShellOutput(text) {
  return String(text || "").replace(SECRET_OUTPUT_PATTERN, (match) => {
    if (/^Bearer/i.test(match)) return "Bearer ***";
    if (/^sk-/i.test(match)) return "sk-***";
    return match.replace(/[=:]\s*['"]?[^\s'"]+/i, "=***");
  });
}

export function resolveLocalShell(command) {
  if (process.platform === "win32") {
    if (process.env.AZYCODE_SHELL_MODE === "cmd") {
      return {
        file: process.env.ComSpec || "cmd.exe",
        args: ["/d", "/s", "/c", command],
        shellName: "cmd"
      };
    }
    const ps = process.env.AZYCODE_POWERSHELL || "powershell.exe";
    return {
      file: ps,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
      shellName: "powershell"
    };
  }
  return {
    file: process.env.SHELL || "sh",
    args: ["-lc", command],
    shellName: "posix-sh"
  };
}

export function prepareShellCommand(command, policy) {
  const classification = classifyShellCommand(command);
  const local = resolveLocalShell(command);
  const filteredEnv = filterEnv(process.env, policy.envAllowlist);

  return {
    file: local.file,
    args: local.args,
    shellName: local.shellName,
    cwd: policy.cwd,
    env: filteredEnv,
    timeout: policy.timeoutMs,
    maxStdoutBytes: policy.maxStdoutBytes,
    maxStderrBytes: policy.maxStderrBytes,
    classification,
    logCommand: policy.redactSecrets ? redactCommand(command) : command,
    backend: policy.mode
  };
}

export function probeContainerBinary(runtime) {
  const binary = runtime === "podman" ? "podman" : "docker";
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function buildContainerArgs(policy, { runtime = "docker", command, env = {} } = {}) {
  const binary = runtime === "podman" ? "podman" : "docker";
  const args = ["run", "--rm", "-i"];
  if (policy.network === "deny") args.push("--network", "none");
  if (policy.readonlyRoot) args.push("--read-only");
  args.push("-w", "/workspace", "-v", `${policy.cwd}:/workspace:rw`);
  for (const mount of policy.mounts) {
    if (mount?.source && mount?.target) {
      args.push("-v", `${mount.source}:${mount.target}${mount.readonly ? ":ro" : ""}`);
    }
  }
  if (process.platform !== "win32") {
    args.push("--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
  }
  if (policy.passEnv) {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined || value === null) continue;
      args.push("-e", `${key}=${value}`);
    }
  }
  const image = policy.image || "node:20-alpine";
  args.push(image, "sh", "-lc", command);
  return { binary, args, image, runtime: binary };
}

export function resolveShellInvocation(command, cfg, cwd, deps = {}) {
  const policy = resolveExecutionPolicy(cfg, cwd);
  const prepared = prepareShellCommand(command, policy);
  const probe = deps.probeContainerBinary || probeContainerBinary;

  if (policy.mode === "none") {
    return { ...prepared, blocked: true, reason: "sandbox.mode=none disables shell execution" };
  }

  if (policy.mode === "docker" || policy.mode === "podman") {
    if (!probe(policy.mode)) {
      const msg = `${policy.mode} binary not found or not runnable`;
      if (policy.fallbackMode === "local") {
        warn(`${msg}; falling back to local execution`);
        return {
          ...prepared,
          useContainer: false,
          backend: "local",
          fallbackFrom: policy.mode,
          fallbackReason: msg
        };
      }
      return {
        ...prepared,
        blocked: true,
        reason: `${msg}. Install ${policy.mode}, set sandbox.fallbackMode=local, or use sandbox.mode=local`
      };
    }
    const container = buildContainerArgs(policy, {
      runtime: policy.mode,
      command,
      env: prepared.env
    });
    return { ...prepared, container, useContainer: true, backend: policy.mode };
  }

  return { ...prepared, useContainer: false, backend: "local" };
}

export async function executePreparedShell(invocation, options = {}) {
  const started = Date.now();
  const timeout = Math.max(1, Number(options.timeoutMs) || invocation.timeout || 60_000);
  const redact = options.redact !== false && invocation.redactSecrets !== false;
  const runner = invocation.useContainer
    ? { file: invocation.container.binary, args: invocation.container.args, cwd: invocation.cwd, env: process.env }
    : { file: invocation.file, args: invocation.args, cwd: invocation.cwd, env: invocation.env };

  info(`shell backend=${invocation.backend || "local"} shell=${invocation.shellName || "sh"} cmd=${invocation.logCommand}`);

  try {
    const raw = await execFileCancellable(runner.file, runner.args, {
      cwd: runner.cwd,
      env: runner.env,
      timeout,
      maxStdoutBytes: invocation.maxStdoutBytes,
      maxStderrBytes: invocation.maxStderrBytes,
      signal: options.signal
    });
    return createShellResult({
      ok: true,
      code: 0,
      stdout: redact ? redactShellOutput(raw.stdout) : raw.stdout,
      stderr: redact ? redactShellOutput(raw.stderr) : raw.stderr,
      signal: null,
      truncated: Boolean(raw.truncatedStdout || raw.truncatedStderr),
      durationMs: Date.now() - started,
      backend: invocation.useContainer ? invocation.container.runtime : "local",
      shellName: invocation.shellName,
      command: invocation.logCommand,
      fallbackFrom: invocation.fallbackFrom || null,
      fallbackReason: invocation.fallbackReason || null
    });
  } catch (error) {
    if (error.message === "Aborted" || options.signal?.aborted) throw error;
    return createShellResult({
      ok: false,
      code: error.code ?? "unknown",
      stdout: redact ? redactShellOutput(error.stdout || "") : String(error.stdout || ""),
      stderr: redact ? redactShellOutput(error.stderr || "") : String(error.stderr || ""),
      signal: error.signal || (error.killed ? "SIGTERM" : null),
      truncated: Boolean(error.truncatedStdout || error.truncatedStderr),
      durationMs: Date.now() - started,
      backend: invocation.useContainer ? invocation.container?.runtime : "local",
      shellName: invocation.shellName,
      command: invocation.logCommand,
      fallbackFrom: invocation.fallbackFrom || null,
      fallbackReason: invocation.fallbackReason || null,
      error: sanitizeShellErrorMessage(error.message)
    });
  }
}

function sanitizeShellErrorMessage(message) {
  return redactCommand(String(message || "")).replace(/Command failed: \S+.*$/m, (line) => {
    const parts = line.split(" ");
    return `${parts[0]} ${parts[1]} [redacted]`;
  });
}

export function createShellResult(fields) {
  return {
    ok: Boolean(fields.ok),
    code: fields.code ?? 0,
    stdout: String(fields.stdout ?? ""),
    stderr: String(fields.stderr ?? ""),
    signal: fields.signal || null,
    truncated: Boolean(fields.truncated),
    durationMs: Number(fields.durationMs) || 0,
    backend: fields.backend || "local",
    shellName: fields.shellName || null,
    command: fields.command || "",
    fallbackFrom: fields.fallbackFrom || null,
    fallbackReason: fields.fallbackReason || null,
    error: fields.error || null
  };
}

export function formatShellResultForModel(result) {
  const lines = [];
  if (result.fallbackFrom) {
    lines.push(`[sandbox] ${result.fallbackFrom} unavailable; ran locally (${result.fallbackReason})`);
  }
  if (result.ok) {
    const body = [result.stdout, result.stderr].filter(Boolean).join("\n");
    if (result.truncated) lines.push("[output truncated]");
    return [...lines, body || "(no output)"].filter(Boolean).join("\n");
  }
  lines.push(`exit code: ${result.code ?? "unknown"}`);
  if (result.signal) lines.push(`signal: ${result.signal}`);
  if (result.stdout) lines.push(`stdout:\n${result.stdout.slice(0, 4000)}`);
  if (result.stderr) lines.push(`stderr:\n${result.stderr.slice(0, 4000)}`);
  if (result.truncated) lines.push("output truncated");
  if (result.error && !String(result.error).startsWith("Command failed")) lines.push(result.error);
  return lines.join("\n");
}

export function describeExecutionPolicy(policy) {
  return {
    mode: policy.mode,
    network: policy.network,
    readonlyRoot: policy.readonlyRoot,
    cwd: policy.cwd,
    image: policy.image,
    fallbackMode: policy.fallbackMode,
    envAllowlistCount: policy.envAllowlist.length,
    passEnv: policy.passEnv,
    timeoutMs: policy.timeoutMs,
    maxStdoutBytes: policy.maxStdoutBytes,
    maxStderrBytes: policy.maxStderrBytes,
    redactSecrets: policy.redactSecrets
  };
}

export function sandboxStatus(cfg = {}, cwd = process.cwd(), deps = {}) {
  const policy = resolveExecutionPolicy(cfg, cwd);
  const probe = deps.probeContainerBinary || probeContainerBinary;
  const dockerAvailable = probe("docker");
  const podmanAvailable = probe("podman");
  const localShell = resolveLocalShell("echo ok");
  return {
    policy: describeExecutionPolicy(policy),
    localShell: { file: localShell.file, shellName: localShell.shellName },
    runtimes: {
      docker: { available: dockerAvailable, selected: policy.mode === "docker" },
      podman: { available: podmanAvailable, selected: policy.mode === "podman" }
    },
    effectiveBackend: policy.mode === "docker" && !dockerAvailable && policy.fallbackMode === "local"
      ? "local (fallback)"
      : policy.mode === "podman" && !podmanAvailable && policy.fallbackMode === "local"
        ? "local (fallback)"
        : policy.mode
  };
}

export function isContainerRuntimeAvailable(runtime, deps = {}) {
  const probe = deps.probeContainerBinary || probeContainerBinary;
  return probe(runtime);
}