import { spawn } from "node:child_process";

export function mergeAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (!active.length) return null;
  if (active.length === 1) return active[0];
  const controller = new AbortController();
  const abort = (reason) => {
    if (!controller.signal.aborted) controller.abort(reason);
  };
  const listeners = active.map((signal) => {
    if (signal.aborted) {
      abort(signal.reason || new Error("Aborted"));
      return null;
    }
    const onAbort = () => abort(signal.reason || new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    return { signal, onAbort };
  });
  controller.signal.addEventListener("abort", () => {
    for (const listener of listeners) {
      if (!listener) continue;
      listener.signal.removeEventListener("abort", listener.onAbort);
    }
  }, { once: true });
  return controller.signal;
}

export function execFileCancellable(file, args, options = {}) {
  const {
    cwd,
    timeout = null,
    maxBuffer = 1024 * 1024 * 8,
    maxStdoutBytes = maxBuffer,
    maxStderrBytes = maxBuffer,
    signal: externalSignal = null,
    env,
    shell = false
  } = options;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let truncatedStdout = false;
    let truncatedStderr = false;
    let settled = false;
    let timeoutTimer = null;
    let child = null;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      externalSignal?.removeEventListener("abort", onAbort);
    };

    let pendingKillError = null;

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };

    const killChild = (error) => {
      if (settled) return;
      if (!child || child.killed) {
        finish(error);
        return;
      }
      if (pendingKillError) return;
      pendingKillError = error;
      try {
        child.kill("SIGTERM");
      } catch {
        pendingKillError = null;
        finish(error);
        return;
      }
      setTimeout(() => {
        if (child && !child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {
            // ignore secondary kill failures
          }
        }
      }, 250);
    };

    const onAbort = () => {
      const reason = externalSignal?.reason;
      const error = reason instanceof Error ? reason : new Error("Aborted");
      error.killed = true;
      killChild(error);
    };

    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener("abort", onAbort, { once: true });

    child = spawn(file, args, {
      cwd,
      env,
      shell,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const overflow = (stream) => {
      const error = Object.assign(new Error("maxBuffer length exceeded"), {
        killed: true,
        code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
        stdout,
        stderr,
        truncatedStdout,
        truncatedStderr
      });
      if (stream === "stdout") truncatedStdout = true;
      if (stream === "stderr") truncatedStderr = true;
      killChild(error);
    };

    child.stdout?.on("data", (chunk) => {
      const next = stdout + String(chunk);
      if (next.length > maxStdoutBytes) return overflow("stdout");
      stdout = next;
    });
    child.stderr?.on("data", (chunk) => {
      const next = stderr + String(chunk);
      if (next.length > maxStderrBytes) return overflow("stderr");
      stderr = next;
    });

    child.on("error", (error) => finish(error));
    child.on("close", (code, sig) => {
      if (settled) return;
      if (pendingKillError) {
        pendingKillError.stdout = stdout;
        pendingKillError.stderr = stderr;
        pendingKillError.truncatedStdout = truncatedStdout;
        pendingKillError.truncatedStderr = truncatedStderr;
        finish(pendingKillError);
        return;
      }
      if (code === 0) {
        finish(null, { stdout, stderr, truncatedStdout, truncatedStderr, code: 0, signal: sig || null });
        return;
      }
      const error = new Error(`Command failed: ${file} ${args.join(" ")}`);
      error.code = code;
      error.stdout = stdout;
      error.stderr = stderr;
      error.killed = Boolean(sig);
      error.signal = sig;
      error.truncatedStdout = truncatedStdout;
      error.truncatedStderr = truncatedStderr;
      finish(error);
    });

    if (timeout && timeout > 0) {
      timeoutTimer = setTimeout(() => {
        const error = new Error(`Command timed out after ${timeout}ms`);
        error.code = "ETIMEDOUT";
        error.killed = true;
        error.stdout = stdout;
        error.stderr = stderr;
        error.truncatedStdout = truncatedStdout;
        error.truncatedStderr = truncatedStderr;
        killChild(error);
      }, timeout);
    }
  });
}