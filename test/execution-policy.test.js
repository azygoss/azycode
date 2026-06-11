import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveExecutionPolicy,
  prepareShellCommand,
  describeExecutionPolicy,
  buildContainerArgs,
  redactCommand,
  filterEnv
} from "../src/execution-policy.js";
import { defaultConfig } from "../src/config.js";

test("resolveExecutionPolicy returns local defaults", () => {
  const cfg = defaultConfig();
  const policy = resolveExecutionPolicy(cfg, process.cwd());
  assert.equal(policy.mode, "local");
  assert.ok(policy.envAllowlist.length > 0);
});

test("prepareShellCommand redacts secrets in log output", () => {
  const policy = resolveExecutionPolicy(defaultConfig(), process.cwd());
  const prepared = prepareShellCommand("export API_KEY=sk-abcdefghijklmnop", policy);
  assert.match(prepared.logCommand, /API_KEY=\*\*\*/);
  assert.doesNotMatch(prepared.logCommand, /abcdefghijklmnop/);
});

test("filterEnv excludes secret-like variables", () => {
  const env = filterEnv({ PATH: "/bin", HOME: "/tmp", MY_SECRET_TOKEN: "abc" }, ["PATH", "HOME", "MY_SECRET_TOKEN"]);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.MY_SECRET_TOKEN, undefined);
});

test("buildContainerArgs constructs docker invocation", () => {
  const policy = resolveExecutionPolicy({ sandbox: { mode: "docker", network: "deny" } }, "/tmp/ws");
  const container = buildContainerArgs(policy, { command: "npm test" });
  assert.equal(container.binary, "docker");
  assert(container.args.includes("--network"));
  assert(container.args.includes("none"));
});

test("describeExecutionPolicy is JSON-serializable", () => {
  const policy = resolveExecutionPolicy(defaultConfig(), process.cwd());
  const described = describeExecutionPolicy(policy);
  assert.equal(described.mode, "local");
  assert.ok(described.timeoutMs > 0);
});

test("redactCommand masks bearer tokens", () => {
  assert.match(redactCommand("curl -H 'Authorization: Bearer abc.def.ghi'"), /Bearer \*\*\*/);
});