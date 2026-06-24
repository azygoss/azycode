import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { mergeAbortSignals } from "./exec.js";
import { warn } from "./logger.js";

const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "TMP", "TEMP"];

/**
 * Environment keys that may be supplied via a server's `env` but must never be
 * forwarded to the spawned child. They allow code injection (`LD_PRELOAD`,
 * `DYLD_INSERT_LIBRARIES`, `NODE_OPTIONS`) or otherwise hijack execution.
 */
const DENIED_SERVER_ENV_KEYS = [
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FALLBACK_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "ELECTRON_RUN_AS_NODE",
  "ELECTRON_ENABLE_LOGGING",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "PERL5OPT",
  "RUBYOPT",
  "BASH_ENV",
  "ENV",
  "ENVIRONMENT"
];

/** Characters that must not appear in an MCP server command. */
const FORBIDDEN_COMMAND_CHARS = /[;|&$`<>()\n\r]/;

/**
 * Validate an MCP server `command` before it is spawned. We allow a bare
 * executable name or an absolute path, plus simple arguments via `args`, but we
 * reject shell metacharacters that would enable injection when the command is
 * later composed or logged. The command itself is spawned directly (not via a
 * shell), but validation defends against misconfigured or hostile config.
 */
export function validateMcpServerCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, reason: "MCP server command is empty" };
  if (FORBIDDEN_COMMAND_CHARS.test(cmd)) {
    return { ok: false, reason: `MCP server command contains forbidden shell metacharacters: ${cmd}` };
  }
  return { ok: true, command: cmd };
}

export function normalizeMcpServer(name, server = {}) {
  const rawEnv = server.env && typeof server.env === "object" ? server.env : {};
  const safeEnv = {};
  for (const [key, value] of Object.entries(rawEnv)) {
    if (DENIED_SERVER_ENV_KEYS.includes(key)) continue;
    safeEnv[key] = value;
  }
  return {
    name,
    transport: server.transport || "stdio",
    command: server.command || "",
    args: Array.isArray(server.args) ? server.args : [],
    enabled: server.enabled !== false,
    startupTimeoutMs: Number(server.startupTimeoutMs) > 0 ? Number(server.startupTimeoutMs) : DEFAULT_STARTUP_TIMEOUT_MS,
    requestTimeoutMs: Number(server.requestTimeoutMs) > 0 ? Number(server.requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS,
    envAllowlist: Array.isArray(server.envAllowlist) ? server.envAllowlist : DEFAULT_ENV_ALLOWLIST,
    env: safeEnv,
    toolPolicy: {
      allow: Array.isArray(server.toolPolicy?.allow) ? server.toolPolicy.allow : [],
      deny: Array.isArray(server.toolPolicy?.deny) ? server.toolPolicy.deny : []
    }
  };
}

export function buildMcpServerEnv(server) {
  const normalized = normalizeMcpServer(server.name || "server", server);
  const env = {};
  for (const key of normalized.envAllowlist) {
    // Never forward denied injection vectors even if an allowlist names them.
    if (DENIED_SERVER_ENV_KEYS.includes(key)) continue;
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(normalized.env)) {
    if (DENIED_SERVER_ENV_KEYS.includes(key)) continue;
    env[key] = String(value);
  }
  return env;
}

export function isMcpToolAllowed(server, toolName) {
  const policy = normalizeMcpServer(server.name || "server", server).toolPolicy;
  if (policy.deny.includes(toolName)) return false;
  if (policy.allow.length && !policy.allow.includes(toolName)) return false;
  return true;
}

export function qualifyMcpToolName(serverName, toolName) {
  return `${serverName}__${toolName}`;
}

export function detectMcpToolCollisions(entries) {
  const seen = new Map();
  const collisions = [];
  for (const entry of entries) {
    const qualified = qualifyMcpToolName(entry.serverName, entry.tool.name);
    if (seen.has(qualified)) {
      collisions.push({ tool: qualified, servers: [seen.get(qualified), entry.serverName] });
    } else {
      seen.set(qualified, entry.serverName);
    }
  }
  return collisions;
}

export function listMcpToolCatalog(cfg = loadConfig()) {
  return listConfiguredMcpServers(cfg)
    .filter((server) => server.enabled !== false && server.command)
    .map((server) => ({
      name: `${server.name}__*`,
      policy: "ask",
      description: `[mcp:${server.name}] stdio server: ${server.command}`,
      parameters: ["tool-specific"],
      required: [],
      transport: server.transport
    }));
}

export function listConfiguredMcpServers(cfg = loadConfig()) {
  return Object.entries(cfg.mcpServers || {}).map(([name, server]) => normalizeMcpServer(name, server));
}

export async function probeMcpServers(cfg = loadConfig()) {
  const servers = listConfiguredMcpServers(cfg).filter((server) => server.enabled && server.command);
  const results = [];
  for (const server of servers) {
    const client = new McpStdioClient({
      name: server.name,
      command: server.command,
      args: server.args,
      env: buildMcpServerEnv(server),
      startupTimeoutMs: server.startupTimeoutMs,
      requestTimeoutMs: server.requestTimeoutMs
    });
    try {
      await client.start();
      const [tools, resources, prompts] = await Promise.all([
        client.listTools(),
        client.listResources().catch(() => []),
        client.listPrompts().catch(() => [])
      ]);
      results.push({
        name: server.name,
        ok: true,
        command: server.command,
        tools: tools.length,
        resources: resources.length,
        prompts: prompts.length,
        stderr: client.stderrTail(),
        allowedTools: tools.filter((tool) => isMcpToolAllowed(server, tool.name)).map((tool) => tool.name)
      });
    } catch (error) {
      results.push({
        name: server.name,
        ok: false,
        command: server.command,
        error: error.message,
        stderr: client.stderrTail()
      });
    } finally {
      await client.close();
    }
  }
  return results;
}

export async function inspectMcpServer(name, cfg = loadConfig()) {
  const server = normalizeMcpServer(name, cfg.mcpServers?.[name]);
  if (!server.command) throw new Error(`MCP server not configured: ${name}`);
  const client = new McpStdioClient({
    name: server.name,
    command: server.command,
    args: server.args,
    env: buildMcpServerEnv(server),
    startupTimeoutMs: server.startupTimeoutMs,
    requestTimeoutMs: server.requestTimeoutMs
  });
  try {
    await client.start();
    const [tools, resources, prompts] = await Promise.all([
      client.listTools(),
      client.listResources().catch(() => []),
      client.listPrompts().catch(() => [])
    ]);
    return { server, tools, resources, prompts, stderr: client.stderrTail() };
  } finally {
    await client.close();
  }
}

export async function createMcpTools(cfg = loadConfig()) {
  const servers = listConfiguredMcpServers(cfg).filter((server) => server.enabled && server.command);
  if (!servers.length) return { tools: [], close: async () => {}, warnings: [] };

  const clients = [];
  const tools = [];
  const warnings = [];
  const entries = [];

  const started = await Promise.all(servers.map(async (server) => {
    if (server.transport !== "stdio") {
      warnings.push(`MCP server ${server.name}: unsupported transport ${server.transport}`);
      return null;
    }
    const client = new McpStdioClient({
      name: server.name,
      command: server.command,
      args: server.args,
      env: buildMcpServerEnv(server),
      startupTimeoutMs: server.startupTimeoutMs,
      requestTimeoutMs: server.requestTimeoutMs
    });
    try {
      await client.start();
      const toolList = await client.listTools();
      return { client, server, toolList };
    } catch (error) {
      const detail = client.stderrTail();
      warnings.push(`MCP server ${server.name} failed to start: ${error.message}${detail ? ` | stderr: ${detail}` : ""}`);
      await client.close();
      return null;
    }
  }));

  for (const entry of started) {
    if (!entry) continue;
    const { client, server, toolList } = entry;
    for (const tool of toolList) {
      if (!isMcpToolAllowed(server, tool.name)) continue;
      entries.push({ serverName: server.name, tool });
    }
    clients.push({ client, serverName: server.name });
  }

  for (const collision of detectMcpToolCollisions(entries)) {
    warnings.push(`MCP tool collision for ${collision.tool} across servers: ${collision.servers.join(", ")}`);
  }

  const reserved = new Set();
  for (const entry of entries) {
    const qualified = qualifyMcpToolName(entry.serverName, entry.tool.name);
    if (reserved.has(qualified)) continue;
    reserved.add(qualified);
    const { client, serverName } = clients.find((item) => item.serverName === entry.serverName);
    tools.push({
      name: qualified,
      schema: {
        type: "function",
        function: {
          name: qualified,
          description: `[mcp:${serverName}] ${entry.tool.description || entry.tool.name}`,
          parameters: entry.tool.inputSchema || { type: "object", properties: {} }
        }
      },
      run: async (args, { signal = null } = {}) => {
        try {
          return await client.callTool(entry.tool.name, args, { signal });
        } catch (error) {
          const detail = client.stderrTail();
          throw new Error(`MCP tool ${qualified} failed: ${error.message}${detail ? ` | stderr: ${detail}` : ""}`);
        }
      }
    });
  }

  return {
    tools,
    warnings,
    close: async () => {
      await Promise.all(clients.map(({ client }) => client.close()));
    }
  };
}

export class McpStdioClient {
  constructor({ name, command, args, env, startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS, requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.startupTimeoutMs = startupTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.child = null;
    this.buffer = "";
    this.stderr = "";
    this.pending = new Map();
    this.nextId = 1;
    this.abortController = null;
    this.started = false;
  }

  stderrTail(limit = 400) {
    return this.stderr.trim().slice(-limit);
  }

  async start() {
    if (this.started) return;
    const check = validateMcpServerCommand(this.command);
    if (!check.ok) throw new Error(`MCP server ${this.name}: ${check.reason}`);
    this.child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderr += String(chunk);
      if (this.stderr.length > 8000) this.stderr = this.stderr.slice(-8000);
    });
    this.child.on("error", (error) => this.rejectAll(new Error(`MCP server ${this.name} process error: ${error.message}`)));
    this.child.on("close", (code) => {
      if (!this.started) {
        this.rejectAll(new Error(`MCP server ${this.name} exited during startup (code ${code ?? "unknown"})${this.stderrTail() ? `: ${this.stderrTail()}` : ""}`));
      } else {
        this.rejectAll(new Error(`MCP server ${this.name} exited (code ${code ?? "unknown"})`));
      }
    });
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "azycode", version: "0.1.0" }
    }, { timeoutMs: this.startupTimeoutMs });
    await this.notify("notifications/initialized", {});
    this.started = true;
  }

  async close() {
    this.abortAll(new Error(`MCP server ${this.name} closed`));
    const child = this.child;
    this.child = null;
    this.started = false;
    if (!child || child.killed) return;
    // Graceful shutdown: SIGTERM, then escalate to SIGKILL if the process does
    // not exit within the grace window. This prevents zombie/hung MCP servers.
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(escalate);
        resolve();
      };
      child.once("exit", finish);
      const escalate = setTimeout(() => {
        try {
          if (!child.killed) child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
        // Give SIGKILL a brief moment to take effect before resolving.
        setTimeout(finish, 50);
      }, 1500);
    });
  }

  onData(chunk) {
    this.buffer += String(chunk);
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) {
          reject(new Error(message.error.message || `MCP error from ${this.name}`));
        } else {
          resolve(message.result);
        }
      }
    }
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  abortAll(error) {
    this.rejectAll(error);
    if (this.abortController && !this.abortController.signal.aborted) {
      this.abortController.abort(error);
    }
  }

  send(payload) {
    if (!this.child?.stdin?.writable) throw new Error(`MCP server ${this.name} is not running`);
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  request(method, params, { signal = null, timeoutMs = null } = {}) {
    const id = this.nextId++;
    const activeSignal = mergeAbortSignals([signal, this.abortController?.signal]);
    const waitMs = timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timed out after ${waitMs}ms: ${this.name}.${method}`));
      }, waitMs);
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        const reason = activeSignal?.reason;
        const error = reason instanceof Error ? reason : new Error("Aborted");
        reject(error);
        this.child?.kill("SIGTERM");
      };
      if (activeSignal?.aborted) {
        onAbort();
        return;
      }
      activeSignal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          activeSignal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          activeSignal?.removeEventListener("abort", onAbort);
          reject(error);
        }
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools || [];
  }

  async listResources() {
    const result = await this.request("resources/list", {});
    return result?.resources || [];
  }

  async readResource(uri) {
    return this.request("resources/read", { uri });
  }

  async listPrompts() {
    const result = await this.request("prompts/list", {});
    return result?.prompts || [];
  }

  async getPrompt(name, args = {}) {
    return this.request("prompts/get", { name, arguments: args });
  }

  async callTool(name, args, { signal = null } = {}) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
    }
    if (signal && !this.abortController) {
      this.abortController = new AbortController();
      const onAbort = () => {
        const reason = signal.reason instanceof Error ? signal.reason : new Error("Aborted");
        this.abortAll(reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const result = await this.request("tools/call", { name, arguments: args || {} }, { signal });
    const text = (result?.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    return text || JSON.stringify(result || {}, null, 2);
  }
}

export function fakeMcpServerPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../test/fixtures/fake-mcp-server.js");
}