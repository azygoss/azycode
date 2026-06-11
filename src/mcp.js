import { spawn } from "node:child_process";
import { loadConfig } from "./config.js";
import { mergeAbortSignals } from "./exec.js";

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
  return Object.entries(cfg.mcpServers || {}).map(([name, server]) => ({
    name,
    transport: server.transport || "stdio",
    command: server.command || "",
    args: server.args || [],
    enabled: server.enabled !== false
  }));
}

export async function createMcpTools(cfg = loadConfig()) {
  const servers = Object.entries(cfg.mcpServers || {}).filter(([, server]) => server?.enabled !== false);
  if (!servers.length) return { tools: [], close: async () => {} };

  const clients = [];
  const tools = [];

  const started = await Promise.all(servers.map(async ([serverName, server]) => {
    if ((server.transport || "stdio") !== "stdio" || !server.command) return null;
    const client = new McpStdioClient({
      name: serverName,
      command: server.command,
      args: server.args || [],
      env: { ...process.env, ...(server.env || {}) }
    });
    await client.start();
    const toolList = await client.listTools();
    return { client, serverName, toolList };
  }));

  for (const entry of started) {
    if (!entry) continue;
    const { client, serverName, toolList } = entry;
    clients.push(client);
    for (const tool of toolList) {
      const qualified = `${serverName}__${tool.name}`;
      tools.push({
        name: qualified,
        schema: {
          type: "function",
          function: {
            name: qualified,
            description: `[mcp:${serverName}] ${tool.description || tool.name}`,
            parameters: tool.inputSchema || { type: "object", properties: {} }
          }
        },
        run: async (args, { signal = null } = {}) => client.callTool(tool.name, args, { signal })
      });
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.all(clients.map((client) => client.close()));
    }
  };
}

class McpStdioClient {
  constructor({ name, command, args, env }) {
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.child = null;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.abortController = null;
  }

  async start() {
    this.child = spawn(this.command, this.args, {
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", () => this.rejectAll(new Error(`MCP server ${this.name} exited`)));
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "azycode", version: "0.1.0" }
    });
    await this.notify("notifications/initialized", {});
  }

  async close() {
    this.abortAll(new Error(`MCP server ${this.name} closed`));
    if (!this.child || this.child.killed) return;
    this.child.kill("SIGTERM");
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
        if (message.error) reject(new Error(message.error.message || `MCP error from ${this.name}`));
        else resolve(message.result);
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

  request(method, params, { signal = null } = {}) {
    const id = this.nextId++;
    const activeSignal = mergeAbortSignals([signal, this.abortController?.signal]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${this.name}.${method}`));
      }, 30_000);
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