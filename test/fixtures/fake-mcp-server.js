#!/usr/bin/env node
import readline from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo arguments back",
    inputSchema: { type: "object", properties: { message: { type: "string" } } }
  }
];
const resources = [{ uri: "file:///demo.txt", name: "demo", mimeType: "text/plain" }];
const prompts = [{ name: "greet", description: "Simple greeting prompt" }];

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function respondError(id, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "fake-mcp", version: "1.0.0" }
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "tools/list") {
    respond(id, { tools });
    return;
  }
  if (method === "tools/call") {
    respond(id, {
      content: [{ type: "text", text: `echo:${JSON.stringify(params?.arguments || {})}` }]
    });
    return;
  }
  if (method === "resources/list") {
    respond(id, { resources });
    return;
  }
  if (method === "resources/read") {
    respond(id, { contents: [{ uri: params?.uri, mimeType: "text/plain", text: "demo resource content" }] });
    return;
  }
  if (method === "prompts/list") {
    respond(id, { prompts });
    return;
  }
  if (method === "prompts/get") {
    respond(id, { messages: [{ role: "user", content: `Prompt:${params?.name}` }] });
    return;
  }
  if (id != null) respondError(id, `Unknown method: ${method}`);
});

process.stderr.write("fake-mcp-server ready\n");