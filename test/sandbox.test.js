import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContainerArgs,
  createShellResult,
  executePreparedShell,
  formatShellResultForModel,
  prepareShellCommand,
  redactShellOutput,
  resolveExecutionPolicy,
  resolveLocalShell,
  resolveShellInvocation,
  sandboxStatus
} from "../src/execution-policy.js";
import { defaultConfig } from "../src/config.js";

test("resolveShellInvocation falls back to local when docker is missing", () => {
  const cfg = defaultConfig();
  cfg.sandbox.mode = "docker";
  cfg.sandbox.fallbackMode = "local";
  const invocation = resolveShellInvocation("echo hi", cfg, process.cwd(), {
    probeContainerBinary: () => false
  });
  assert.equal(invocation.useContainer, false);
  assert.equal(invocation.fallbackFrom, "docker");
  assert.match(invocation.fallbackReason, /not found/i);
});

test("resolveShellInvocation blocks when docker missing and fallback none", () => {
  const cfg = defaultConfig();
  cfg.sandbox.mode = "docker";
  cfg.sandbox.fallbackMode = "none";
  const invocation = resolveShellInvocation("echo hi", cfg, process.cwd(), {
    probeContainerBinary: () => false
  });
  assert.equal(invocation.blocked, true);
  assert.match(invocation.reason, /not found/i);
});

test("resolveShellInvocation uses container when runtime is available", () => {
  const cfg = defaultConfig();
  cfg.sandbox.mode = "podman";
  const invocation = resolveShellInvocation("npm test", cfg, "/tmp/ws", {
    probeContainerBinary: (runtime) => runtime === "podman"
  });
  assert.equal(invocation.useContainer, true);
  assert.equal(invocation.container.binary, "podman");
});

test("buildContainerArgs passes allowlisted env and disables network", () => {
  const policy = {
    cwd: "/tmp/project",
    network: "deny",
    readonlyRoot: true,
    mounts: [{ source: "/cache", target: "/cache", readonly: true }],
    image: "node:20-alpine",
    passEnv: true
  };
  const container = buildContainerArgs(policy, {
    runtime: "docker",
    command: "npm test",
    env: { PATH: "/bin", HOME: "/tmp" }
  });
  assert(container.args.includes("--network"));
  assert(container.args.includes("none"));
  assert(container.args.includes("--read-only"));
  assert(container.args.includes("-e"));
  assert(container.args.includes("PATH=/bin"));
  assert(container.args.includes("/tmp/project:/workspace:rw"));
});

test("executePreparedShell returns structured success result", async () => {
  const command = process.platform === "win32" ? "echo ok" : "printf ok";
  const invocation = prepareShellCommand(command, resolveExecutionPolicy(defaultConfig(), process.cwd()));
  const result = await executePreparedShell(invocation, { timeoutMs: 5000 });
  assert.equal(result.ok, true);
  assert.equal(result.code, 0);
  assert.match(result.stdout + result.stderr, /ok/);
  assert.ok(result.durationMs >= 0);
});

test("formatShellResultForModel includes fallback notice and exit code", () => {
  const okText = formatShellResultForModel(createShellResult({ ok: true, stdout: "done\n", stderr: "" }));
  assert.match(okText, /done/);
  const failText = formatShellResultForModel(createShellResult({
    ok: false,
    code: 2,
    stderr: "boom",
    fallbackFrom: "docker",
    fallbackReason: "missing"
  }));
  assert.match(failText, /exit code: 2/);
  assert.match(failText, /sandbox.*docker unavailable/i);
});

test("redactShellOutput masks secrets in command output", () => {
  const redacted = redactShellOutput("token=abc123 secret=shh sk-live-abcdefghijklmnop");
  assert.doesNotMatch(redacted, /abcdefghijklmnop/);
});

test("resolveLocalShell uses powershell on Windows unless cmd mode set", () => {
  const prev = process.env.AZYCODE_SHELL_MODE;
  delete process.env.AZYCODE_SHELL_MODE;
  const shell = resolveLocalShell("echo hi");
  if (process.platform === "win32") {
    assert.match(shell.file, /powershell|cmd/i);
    assert.equal(shell.shellName, "powershell");
  } else {
    assert.match(shell.file, /sh|bash|zsh/i);
  }
  process.env.AZYCODE_SHELL_MODE = prev;
});

test("sandboxStatus reports runtime availability with injected probe", () => {
  const status = sandboxStatus(defaultConfig(), process.cwd(), {
    probeContainerBinary: (runtime) => runtime === "docker"
  });
  assert.equal(status.runtimes.docker.available, true);
  assert.equal(status.runtimes.podman.available, false);
  assert.ok(status.localShell.file);
});

test("buildContainerArgs rejects mounts of sensitive host paths", () => {
  const policy = {
    cwd: "/tmp/project",
    network: "deny",
    mounts: [
      { source: "/var/run/docker.sock", target: "/var/run/docker.sock" },
      { source: "/proc", target: "/hostproc" },
      { source: "/sys", target: "/hostsys" },
      { source: "/dev", target: "/hostdev" }
    ],
    image: "node:20-alpine",
    passEnv: false
  };
  assert.throws(
    () => buildContainerArgs(policy, { runtime: "docker", command: "id", env: {} }),
    /docker\.sock|proc|sys|dev|sensitive|forbidden/i
  );
});

test("buildContainerArgs rejects mount of the host docker socket only by source", () => {
  const policy = {
    cwd: "/tmp/project",
    network: "deny",
    mounts: [{ source: "/var/run/docker.sock", target: "/run/docker.sock" }],
    image: "node:20-alpine",
    passEnv: false
  };
  assert.throws(
    () => buildContainerArgs(policy, { runtime: "docker", command: "id", env: {} }),
    /sensitive|forbidden|docker\.sock/i
  );
});

test("buildContainerArgs allows safe cache mounts", () => {
  const policy = {
    cwd: "/tmp/project",
    network: "deny",
    mounts: [{ source: "/tmp/.cache", target: "/root/.cache", readonly: false }],
    image: "node:20-alpine",
    passEnv: false
  };
  const container = buildContainerArgs(policy, { runtime: "docker", command: "npm test", env: {} });
  assert(container.args.some((a, i) => a === "-v" && container.args[i + 1]?.startsWith("/tmp/.cache:")));
});