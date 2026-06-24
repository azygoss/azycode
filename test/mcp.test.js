import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMcpServerEnv,
  createMcpTools,
  detectMcpToolCollisions,
  fakeMcpServerPath,
  inspectMcpServer,
  isMcpToolAllowed,
  normalizeMcpServer,
  probeMcpServers,
  validateMcpServerCommand
} from "../src/mcp.js";

function fakeServerConfig(name = "fake") {
  return {
    mcpServers: {
      [name]: {
        command: process.execPath,
        args: [fakeMcpServerPath()],
        enabled: true
      }
    }
  };
}

test("normalizeMcpServer applies defaults and tool policy", () => {
  const server = normalizeMcpServer("demo", { command: "node", args: ["server.js"] });
  assert.equal(server.name, "demo");
  assert.equal(server.transport, "stdio");
  assert.equal(server.startupTimeoutMs, 10_000);
  assert.deepEqual(server.toolPolicy, { allow: [], deny: [] });
});

test("isMcpToolAllowed respects allow and deny lists", () => {
  const server = normalizeMcpServer("demo", {
    command: "node",
    toolPolicy: { allow: ["read"], deny: ["delete"] }
  });
  assert.equal(isMcpToolAllowed(server, "read"), true);
  assert.equal(isMcpToolAllowed(server, "write"), false);
  assert.equal(isMcpToolAllowed(server, "delete"), false);
});

test("detectMcpToolCollisions finds duplicate qualified names", () => {
  const entries = [
    { serverName: "shared", tool: { name: "echo" } },
    { serverName: "shared", tool: { name: "echo" } }
  ];
  const collisions = detectMcpToolCollisions(entries);
  assert.equal(collisions.length, 1);
  assert.equal(collisions[0].tool, "shared__echo");
  assert.deepEqual(collisions[0].servers, ["shared", "shared"]);
});

test("probeMcpServers connects to fake stdio server", async () => {
  const results = await probeMcpServers(fakeServerConfig());
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].tools, 1);
  assert.equal(results[0].resources, 1);
  assert.equal(results[0].prompts, 1);
  assert.match(results[0].stderr || "", /fake-mcp-server ready/);
});

test("inspectMcpServer lists tools resources and prompts", async () => {
  const detail = await inspectMcpServer("fake", fakeServerConfig());
  assert.equal(detail.tools[0].name, "echo");
  assert.equal(detail.resources[0].uri, "file:///demo.txt");
  assert.equal(detail.prompts[0].name, "greet");
});

test("createMcpTools exposes qualified MCP tools", async () => {
  const { tools, warnings, close } = await createMcpTools(fakeServerConfig());
  try {
    assert.equal(warnings.length, 0);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "fake__echo");
    const output = await tools[0].run({ message: "hi" });
    assert.match(output, /echo:/);
  } finally {
    await close();
  }
});

test("buildMcpServerEnv strips dangerous env keys (LD_PRELOAD, NODE_OPTIONS)", () => {
  const env = buildMcpServerEnv({
    name: "evil",
    command: "node",
    env: {
      LD_PRELOAD: "/tmp/evil.so",
      DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      NODE_OPTIONS: "--require /tmp/pwn.js",
      MY_SAFE_VAR: "ok"
    }
  });
  assert.equal(env.LD_PRELOAD, undefined, "LD_PRELOAD must be stripped");
  assert.equal(env.DYLD_INSERT_LIBRARIES, undefined, "DYLD_INSERT_LIBRARIES must be stripped");
  assert.equal(env.NODE_OPTIONS, undefined, "NODE_OPTIONS must be stripped");
  assert.equal(env.MY_SAFE_VAR, "ok", "safe server env must pass through");
});

test("validateMcpServerCommand rejects shell metacharacters and empty", () => {
  assert.equal(validateMcpServerCommand("").ok, false);
  assert.equal(validateMcpServerCommand("node; rm -rf /").ok, false);
  assert.equal(validateMcpServerCommand("node && cat /etc/passwd").ok, false);
  assert.equal(validateMcpServerCommand("node | tee log").ok, false);
  assert.equal(validateMcpServerCommand("node").ok, true);
  assert.equal(validateMcpServerCommand("/usr/local/bin/node").ok, true);
  assert.equal(validateMcpServerCommand("npx -y @some/server").ok, true);
});

test("normalizeMcpServer drops dangerous env keys", () => {
  const server = normalizeMcpServer("demo", {
    command: "node",
    env: { LD_PRELOAD: "/tmp/x.so", GOOD: "1" }
  });
  assert.equal(server.env.LD_PRELOAD, undefined);
  assert.equal(server.env.GOOD, "1");
});

test("McpStdioClient.close escalates to SIGKILL after SIGTERM", async () => {
  const { McpStdioClient } = await import("../src/mcp.js");
  const { spawn } = await import("node:child_process");
  // Use a fake server that ignores SIGTERM to force escalation.
  const client = new McpStdioClient({
    name: "stubborn",
    command: process.execPath,
    args: ["-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{}, 1000);"],
    env: { PATH: process.env.PATH },
    startupTimeoutMs: 2000,
    requestTimeoutMs: 2000
  });
  // Stub out the network handshake: we only care about process teardown.
  client.child = spawn(client.command, client.args, { env: client.env, stdio: ["pipe", "ignore", "ignore"] });
  client.started = true;
  const pid = client.child.pid;
  await client.close();
  // After close, the process must actually be gone (SIGKILL fallback worked).
  assert.equal(client.child, null);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, "stubborn process should be killed after close()");
});