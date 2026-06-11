import test from "node:test";
import assert from "node:assert/strict";
import { execFileCancellable } from "../src/exec.js";

test("execFileCancellable aborts a long-running subprocess", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const promise = execFileCancellable(process.platform === "win32" ? "cmd" : "sleep", process.platform === "win32" ? ["/c", "timeout", "30"] : ["30"], {
    timeout: 60_000,
    signal: controller.signal
  });
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(promise, /Aborted/i);
  assert.ok(Date.now() - started < 2000);
});

test("execFileCancellable enforces timeout and kills subprocess", async () => {
  const started = Date.now();
  await assert.rejects(
    execFileCancellable(process.platform === "win32" ? "cmd" : "sleep", process.platform === "win32" ? ["/c", "timeout", "30"] : ["2"], {
      timeout: 80
    }),
    /timed out/i
  );
  assert.ok(Date.now() - started < 1500);
});