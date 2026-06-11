import test from "node:test";
import assert from "node:assert/strict";
import {
  createMcpTools,
  detectMcpToolCollisions,
  fakeMcpServerPath,
  inspectMcpServer,
  isMcpToolAllowed,
  normalizeMcpServer,
  probeMcpServers
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