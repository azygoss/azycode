import test from "node:test";
import assert from "node:assert/strict";
import { execFileCancellable } from "../src/exec.js";

test("execFileCancellable enforces separate stderr byte limit", async () => {
  const file = process.execPath;
  const args = ["-e", "process.stderr.write('x'.repeat(5000))"];
  await assert.rejects(
    execFileCancellable(file, args, {
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 100,
      timeout: 5000
    }),
    /maxBuffer|maxBuffer length exceeded/i
  );
});