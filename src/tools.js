import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { confirm } from "./prompt.js";
import { gitGuard, validateBranchName } from "./guard.js";
import { runTodoAction } from "./todos.js";
import { execFileCancellable } from "./exec.js";
import { clearContextPackCache } from "./context.js";
import { listMcpToolCatalog } from "./mcp.js";
import { resolveToolPermission } from "./permissions.js";
import { evaluateShellPolicy } from "./shell-risk.js";
import { assertPatchPathsAllowed, assertWritePathAllowed, evaluateWritePath } from "./path-guard.js";
import { executePreparedShell, formatShellResultForModel, resolveShellInvocation } from "./execution-policy.js";
import { debug } from "./logger.js";

const GIT_TIMEOUT_MS = 20_000;

function execGit(args, root, runOptions = {}, extra = {}) {
  return execFileCancellable("git", args, {
    cwd: root,
    timeout: GIT_TIMEOUT_MS,
    signal: runOptions.signal,
    ...extra
  });
}
const MAX_LIST_ENTRIES = 2000;
const READ_CONCURRENCY = 6;
const SEARCH_EXCLUDE_DIRS = ["node_modules", "dist", ".git", ".next", "build", "coverage", "target", ".cache"];

function invalidateWorkspaceCaches() {
  clearContextPackCache();
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

export function createTools({
  cwd = process.cwd(),
  cfg,
  resolveCfg = null,
  confirmTool = null,
  modeRuntime = null,
  onApproval = null,
  subagentSpawner = null
}) {
  const root = path.resolve(cwd);
  const policySource = resolveCfg || (() => cfg);
  const policy = () => policySource().toolPolicy || {};
  const readCache = new Map();
  const sessionApprovals = new Set();

  function guardWritePath(requested, options = {}) {
    const activeCfg = policySource();
    const result = evaluateWritePath(root, requested, activeCfg, options);
    if (result.allowed === false) throw new Error(result.reason);
    if (result.allowed === null && !options.approved) {
      throw new Error(`Write to protected path blocked: ${result.path} — ${result.reason}`);
    }
    return result;
  }

  async function readTextFile(target, limit) {
    const cacheKey = `${target}:${limit}`;
    if (readCache.has(cacheKey)) return readCache.get(cacheKey);
    const buffer = (await fs.promises.readFile(target)).subarray(0, limit);
    if (isBinaryBuffer(buffer)) {
      const stat = await fs.promises.stat(target);
      const result = { binary: true, size: stat.size };
      readCache.set(cacheKey, result);
      return result;
    }
    const result = { binary: false, text: buffer.toString("utf8") };
    readCache.set(cacheKey, result);
    return result;
  }

  const tools = [
    tool("list_files", "List files below a directory.", {
      type: "object",
      properties: { dir: { type: "string" }, depth: { type: "number" } }
    }, async ({ dir = ".", depth = 2 }) => {
      const base = safePath(root, dir);
      const out = [];
      walk(base, Math.max(0, Number(depth) || 2), out, base, MAX_LIST_ENTRIES);
      if (out.length >= MAX_LIST_ENTRIES) out.push(`... truncated at ${MAX_LIST_ENTRIES} entries`);
      return out.join("\n");
    }),
    tool("read_file", "Read a UTF-8 text file.", {
      type: "object",
      properties: {
        file: { type: "string" },
        startLine: { type: "number" },
        endLine: { type: "number" },
        maxBytes: { type: "number" },
        showLineNumbers: { type: "boolean" }
      },
      required: ["file"]
    }, async ({ file, startLine, endLine, maxBytes = 120000, showLineNumbers = false }) => {
      const limit = Math.max(1, Number(maxBytes) || 120000);
      const target = safePath(root, file);
      const payload = await readTextFile(target, limit);
      if (payload.binary) {
        return `Binary file (${payload.size} bytes). Use file_info or a specialized tool instead of read_file.`;
      }
      return sliceLines(payload.text, { startLine, endLine, showLineNumbers });
    }),
    tool("read_many_files", "Read multiple UTF-8 text files in one call.", {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, maxItems: 20 },
        maxBytesPerFile: { type: "number" }
      },
      required: ["files"]
    }, async ({ files, maxBytesPerFile = 120000 }) => {
      const selected = Array.isArray(files) ? files.slice(0, 20) : [];
      const limit = Math.max(1, Number(maxBytesPerFile) || 120000);
      const chunks = await mapWithConcurrency(selected, READ_CONCURRENCY, async (file) => {
        try {
          const target = safePath(root, file);
          const payload = await readTextFile(target, limit);
          if (payload.binary) {
            return `--- ${file} ---\nBinary file (${payload.size} bytes). Use file_info instead.`;
          }
          return `--- ${file} ---\n${payload.text}`;
        } catch (error) {
          return `--- ${file} ---\nERROR: ${error.message}`;
        }
      });
      return chunks.join("\n\n");
    }),
    tool("file_info", "Inspect file or directory metadata.", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"]
    }, async ({ path: requested }) => {
      const target = safePath(root, requested);
      const stat = fs.statSync(target);
      return JSON.stringify({
        path: path.relative(root, target) || ".",
        type: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        mode: `0${(stat.mode & 0o777).toString(8)}`
      }, null, 2);
    }),
    tool("web_fetch", "Fetch a public HTTP URL and return readable text content.", {
      type: "object",
      properties: {
        url: { type: "string" },
        maxBytes: { type: "number" }
      },
      required: ["url"]
    }, async ({ url, maxBytes = 80_000 }, runOptions = {}) => {
      const target = String(url || "").trim();
      if (!/^https?:\/\//i.test(target)) throw new Error("web_fetch only supports http(s) URLs.");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      runOptions.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const response = await fetch(target, {
          signal: controller.signal,
          headers: { "user-agent": "azycode/0.1 (+https://github.com/azycode)" }
        });
        const buffer = Buffer.from(await response.arrayBuffer()).subarray(0, Math.max(1, Number(maxBytes) || 80_000));
        const contentType = response.headers.get("content-type") || "";
        const text = contentType.includes("html")
          ? buffer.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
          : buffer.toString("utf8");
        return `URL: ${target}\nStatus: ${response.status}\nContent-Type: ${contentType}\n\n${text || "(empty body)"}`;
      } finally {
        runOptions.signal?.removeEventListener("abort", onAbort);
      }
    }),
    tool("search", "Search text in files using ripgrep when available.", {
      type: "object",
      properties: {
        query: { type: "string" },
        dir: { type: "string" },
        maxResults: { type: "number" },
        contextLines: { type: "number" }
      },
      required: ["query"]
    }, async ({ query, dir = ".", maxResults = 200, contextLines = 0 }, runOptions = {}) => {
      const base = safePath(root, dir);
      const execOpts = { timeout: 20000, maxBuffer: 1024 * 1024 * 8, signal: runOptions.signal };
      const limit = Number(maxResults) || 200;
      const context = Math.max(0, Math.min(5, Number(contextLines) || 0));
      try {
        const args = ["--line-number", "--hidden"];
        for (const excluded of SEARCH_EXCLUDE_DIRS) args.push("--glob", `!${excluded}`);
        if (context) args.push("--context", String(context));
        args.push(query, base);
        const { stdout } = await execFileCancellable("rg", args, execOpts);
        return limitLines(stdout || "(no matches)", limit);
      } catch (error) {
        if (error.message === "Aborted" || runOptions.signal?.aborted) throw error;
        if (error.stdout) return limitLines(error.stdout, limit);
        if (error.code === "ENOENT") {
          try {
            const { stdout } = await execFileCancellable(
              "git",
              ["grep", "-n", "-I", "--line-number", "-e", query, "--", "."],
              { ...execOpts, cwd: base }
            );
            return limitLines(stdout || "(no matches)", limit);
          } catch (gitError) {
            if (gitError.message === "Aborted" || runOptions.signal?.aborted) throw gitError;
            if (gitError.stdout) return limitLines(gitError.stdout, limit);
            try {
              const grepArgs = ["-rn", "-e", query];
              for (const excluded of SEARCH_EXCLUDE_DIRS) grepArgs.push(`--exclude-dir=${excluded}`);
              grepArgs.push(base);
              const { stdout } = await execFileCancellable("grep", grepArgs, execOpts);
              return limitLines(stdout || "(no matches)", limit);
            } catch (grepError) {
              if (grepError.message === "Aborted" || runOptions.signal?.aborted) throw grepError;
              if (grepError.stdout) return limitLines(grepError.stdout, limit);
              return "(no matches)";
            }
          }
        }
        return "(no matches)";
      }
    }),
    tool("make_dir", "Create a directory and any missing parent directories.", {
      type: "object",
      properties: { dir: { type: "string" } },
      required: ["dir"]
    }, async ({ dir }) => {
      assertGuard(root, policySource(), "make_dir");
      guardWritePath(dir);
      const target = safePath(root, dir);
      fs.mkdirSync(target, { recursive: true });
      invalidateWorkspaceCaches();
      return `created ${path.relative(root, target) || "."}`;
    }),
    tool("write_file", "Write a UTF-8 text file. Creates parent directories.", {
      type: "object",
      properties: { file: { type: "string" }, content: { type: "string" } },
      required: ["file", "content"]
    }, async ({ file, content }) => {
      assertGuard(root, policySource(), "write_file");
      guardWritePath(file);
      const target = safePath(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      invalidateWorkspaceCaches();
      return `wrote ${path.relative(root, target)}`;
    }),
    tool("edit_file", "Replace exact text in a UTF-8 file. Replaces the first match unless replaceAll is true.", {
      type: "object",
      properties: {
        file: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" },
        replaceAll: { type: "boolean" }
      },
      required: ["file", "search", "replace"]
    }, async ({ file, search, replace, replaceAll = false }) => {
      assertGuard(root, policySource(), "edit_file");
      guardWritePath(file);
      const target = safePath(root, file);
      const original = fs.readFileSync(target, "utf8");
      if (!original.includes(search)) throw new Error(`Search text not found in ${file}`);
      const next = replaceAll ? original.split(search).join(replace) : original.replace(search, replace);
      fs.writeFileSync(target, next, "utf8");
      invalidateWorkspaceCaches();
      const count = replaceAll ? (original.split(search).length - 1) : 1;
      return `edited ${path.relative(root, target)} (${count} replacement${count === 1 ? "" : "s"})`;
    }),
    tool("copy_path", "Copy a file or directory inside the workspace.", {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }, async ({ from, to }) => {
      assertGuard(root, policySource(), "copy_path");
      guardWritePath(to);
      const source = safePath(root, from);
      const target = safePath(root, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true, force: true });
      invalidateWorkspaceCaches();
      return `copied ${path.relative(root, source)} -> ${path.relative(root, target)}`;
    }),
    tool("move_path", "Move or rename a file or directory inside the workspace.", {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }, async ({ from, to }) => {
      assertGuard(root, policySource(), "move_path");
      guardWritePath(from);
      guardWritePath(to);
      const source = safePath(root, from);
      const target = safePath(root, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      invalidateWorkspaceCaches();
      return `moved ${path.relative(root, source)} -> ${path.relative(root, target)}`;
    }),
    tool("delete_path", "Delete a file or directory inside the workspace.", {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"]
    }, async ({ path: requested, recursive = false }) => {
      assertGuard(root, policySource(), "delete_path");
      guardWritePath(requested);
      const target = safePath(root, requested);
      if (target === root) throw new Error("Refusing to delete workspace root.");
      fs.rmSync(target, { recursive: Boolean(recursive), force: false });
      invalidateWorkspaceCaches();
      return `deleted ${path.relative(root, target)}`;
    }),
    tool("apply_patch", "Apply a unified diff patch to the workspace using git apply.", {
      type: "object",
      properties: {
        patch: { type: "string" },
        checkOnly: { type: "boolean" }
      },
      required: ["patch"]
    }, async ({ patch, checkOnly = false }, runOptions = {}) => {
      const activeCfg = policySource();
      if (!checkOnly) {
        assertGuard(root, activeCfg, "apply_patch");
        assertPatchPathsAllowed(root, patch, activeCfg);
      }
      const temp = path.join(os.tmpdir(), `azycode-patch-${process.pid}-${Date.now()}.diff`);
      fs.writeFileSync(temp, patch, "utf8");
      try {
        await execGit(["apply", "--check", temp], root, runOptions, { maxBuffer: 1024 * 1024 * 4 });
        if (checkOnly) return "patch check ok";
        await execGit(["apply", temp], root, runOptions, { maxBuffer: 1024 * 1024 * 4 });
        invalidateWorkspaceCaches();
        return "patch applied";
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }),
    tool("git_diff", "Show git diff for the workspace.", {
      type: "object",
      properties: { staged: { type: "boolean" } }
    }, async ({ staged = false }, runOptions = {}) => {
      const args = staged ? ["diff", "--staged"] : ["diff"];
      const { stdout } = await execGit(args, root, runOptions, { maxBuffer: 1024 * 1024 * 8 });
      return stdout || "(no diff)";
    }),
    tool("git_status", "Show short git status for the workspace.", {
      type: "object",
      properties: {}
    }, async (_args, runOptions = {}) => {
      const { stdout } = await execGit(["status", "--short", "--branch"], root, runOptions, { maxBuffer: 1024 * 1024 * 2 });
      return stdout || "(clean)";
    }),
    tool("git_log", "Show recent git commits.", {
      type: "object",
      properties: { limit: { type: "number" } }
    }, async ({ limit = 10 }, runOptions = {}) => {
      const count = Math.max(1, Math.min(50, Number(limit) || 10));
      const { stdout } = await execGit(["log", `-${count}`, "--oneline", "--decorate"], root, runOptions, { maxBuffer: 1024 * 1024 * 2 });
      return stdout || "(no commits)";
    }),
    tool("git_show", "Show a git object, commit, or file at a revision.", {
      type: "object",
      properties: { rev: { type: "string" }, file: { type: "string" } },
      required: ["rev"]
    }, async ({ rev, file = "" }, runOptions = {}) => {
      const spec = file ? `${rev}:${path.relative(root, safePath(root, file))}` : rev;
      const { stdout } = await execGit(["show", "--stat", "--patch", spec], root, runOptions, { maxBuffer: 1024 * 1024 * 8 });
      return stdout || "(no output)";
    }),
    tool("git_commit", "Stage paths and create a git commit in the workspace.", {
      type: "object",
      properties: {
        message: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        all: { type: "boolean" }
      },
      required: ["message"]
    }, async ({ message, paths = [], all = false }, runOptions = {}) => {
      assertGuard(root, policySource(), "git_commit");
      const args = ["add"];
      if (all) args.push("-A");
      else if (Array.isArray(paths) && paths.length) {
        for (const item of paths) args.push(path.relative(root, safePath(root, item)));
      } else {
        args.push(".");
      }
      await execGit(args, root, runOptions, { maxBuffer: 1024 * 1024 * 4 });
      const { stdout } = await execGit(["commit", "-m", String(message)], root, runOptions, { maxBuffer: 1024 * 1024 * 2 });
      return stdout || "commit created";
    }),
    tool("git_checkout", "Switch or create a git branch. Works on gitGuard-protected branches (unlike shell). Use create:true to run git checkout -b.", {
      type: "object",
      properties: {
        branch: { type: "string" },
        create: { type: "boolean" }
      },
      required: ["branch"]
    }, async ({ branch, create = false }, runOptions = {}) => {
      const name = validateBranchName(branch);
      const args = create ? ["checkout", "-b", name] : ["checkout", name];
      const { stdout, stderr } = await execGit(args, root, runOptions, { maxBuffer: 1024 * 1024 * 2 });
      const guard = gitGuard(root, policySource());
      const hint = guard.ok
        ? "Write and shell tools are allowed on this branch."
        : `Still on a protected branch (${guard.reason}). Pick a non-blocked branch name.`;
      return [stdout, stderr, hint].filter(Boolean).join("\n").trim() || `checked out ${name}`;
    }),
    tool("shell", "Run a shell command in the workspace. Use for tests and build commands.", {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["command"]
    }, async ({ command, timeoutMs = 60000 }, runOptions = {}) => {
      assertGuard(root, policySource(), "shell");
      const activeCfg = policySource();
      const shellEval = evaluateShellPolicy(command, activeCfg);
      if (shellEval.decision === "deny") {
        throw new Error(`Shell command blocked (${shellEval.level}): ${shellEval.reason}`);
      }
      if (shellEval.decision === "ask" && !runOptions.shellApproved) {
        const key = `shell:${command}`;
        if (!sessionApprovals.has(key)) {
          onApproval?.({ type: "approval_requested", tool: "shell", args: { command, risk: shellEval.level, reason: shellEval.reason } });
          const question = `Approve shell [${shellEval.level}]: ${command.slice(0, 160)}`;
          const ok = confirmTool ? await confirmTool(question) : await confirm(question);
          onApproval?.({ type: ok ? "approval_granted" : "approval_denied", tool: "shell", args: { command } });
          if (!ok) return "Tool call rejected by user.";
          sessionApprovals.add(key);
        }
      }
      const invocation = resolveShellInvocation(command, activeCfg, root);
      if (invocation.blocked) throw new Error(invocation.reason);
      debug(`shell exec risk=${shellEval.level} backend=${invocation.backend} cmd=${invocation.logCommand}`);
      const timeout = Math.max(1, Number(timeoutMs) || invocation.timeout || 60000);
      const result = await executePreparedShell(invocation, {
        timeoutMs: timeout,
        signal: runOptions.signal,
        redact: activeCfg.shellPolicy?.redactSecrets !== false
      });
      const text = formatShellResultForModel(result);
      if (!result.ok) throw new Error(text);
      return text;
    }),
    tool("todo", "Manage the workspace todo list for multi-step tasks.", {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "add", "update", "complete", "remove", "clear_completed"]
        },
        id: { type: "string" },
        text: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["action"]
    }, async (args) => runTodoAction(root, args.action, args)),
    ...(subagentSpawner ? [tool("spawn_subagents", "Launch up to 4 specialized subagents in parallel for independent exploration or review tasks. Each task runs in its own bounded agent session.", {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              agent: { type: "string" },
              prompt: { type: "string" },
              mode: { type: "string", enum: ["plan", "build", "always-approve", "goal", "review"] },
              maxSteps: { type: "number" }
            },
            required: ["agent", "prompt"]
          }
        }
      },
      required: ["tasks"]
    }, async ({ tasks }, runOptions = {}) => {
      const results = await subagentSpawner(tasks, runOptions);
      return results;
    })] : []),
    tool("git_worktree", "Create, list, or remove isolated git worktrees under .azycode/worktrees for parallel work.", {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "remove"] },
        name: { type: "string" },
        branch: { type: "string" },
        createBranch: { type: "boolean" }
      },
      required: ["action"]
    }, async ({ action, name, branch, createBranch = false }, runOptions = {}) => {
      const worktreeRoot = path.join(root, ".azycode", "worktrees");
      if (action === "list") {
        try {
          const { stdout } = await execGit(["worktree", "list", "--porcelain"], root, runOptions, { maxBuffer: 1024 * 1024 });
          return stdout || "(no worktrees)";
        } catch (error) {
          if (error.code === "ENOENT" || /not a git repository/i.test(error.message)) return "(not a git repository)";
          throw error;
        }
      }
      if (action === "add") {
        assertGuard(root, policySource(), "git_worktree");
        if (!name || !branch) throw new Error("git_worktree add requires name and branch.");
        const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, "-");
        const target = path.join(worktreeRoot, safeName);
        fs.mkdirSync(worktreeRoot, { recursive: true });
        const args = ["worktree", "add"];
        if (createBranch) args.push("-b", branch, target);
        else args.push(target, branch);
        const { stdout } = await execGit(args, root, runOptions, { maxBuffer: 1024 * 1024 * 2 });
        return stdout || `worktree ${safeName} at ${path.relative(root, target)}`;
      }
      if (action === "remove") {
        assertGuard(root, policySource(), "git_worktree");
        if (!name) throw new Error("git_worktree remove requires name.");
        const safeName = String(name).replace(/[^a-zA-Z0-9._-]/g, "-");
        const target = path.join(worktreeRoot, safeName);
        const { stdout } = await execGit(["worktree", "remove", target, "--force"], root, runOptions, { maxBuffer: 1024 * 1024 });
        return stdout || `removed worktree ${safeName}`;
      }
      throw new Error(`Unsupported git_worktree action: ${action}`);
    }),
    ...(modeRuntime ? [tool("set_mode", "Switch harness mode for the rest of this agent run. Use plan before risky edits; use build for interactive work; use always-approve or goal to implement.", {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plan", "build", "always-approve", "goal", "review"] },
        reason: { type: "string" },
        persist: { type: "boolean" }
      },
      required: ["mode"]
    }, async ({ mode, reason = "", persist = false }) => {
      const result = modeRuntime.setMode(mode, { persist: Boolean(persist), reason });
      const bits = [`Mode switched from ${result.previous} to ${result.mode} for subsequent steps.`];
      if (result.reason) bits.push(`Reason: ${result.reason}`);
      if (result.persist) bits.push("Persisted to config.");
      return bits.join(" ");
    })] : [])
  ];

  return tools.map((entry) => ({
    ...entry,
    run: async (args, runOptions = {}) => {
      const activeCfg = policySource();
      const permission = resolveToolPermission(activeCfg, entry.name, {
        sessionApproval: sessionApprovals.has(entry.name)
      });
      if (permission.allowed === false) {
        onApproval?.({ type: "approval_denied", tool: entry.name, reason: permission.reason });
        return `Tool ${entry.name} denied by policy: ${permission.reason}`;
      }
      if (permission.allowed === null) {
        const allowed = await approved(entry.name, args, policy(), activeCfg, confirmTool, onApproval, permission);
        if (!allowed) return "Tool call rejected by user.";
        sessionApprovals.add(entry.name);
        if (["write_file", "edit_file", "delete_path", "copy_path", "move_path", "make_dir"].includes(entry.name)) {
          const pathArg = args.file || args.path || args.to || args.dir;
          if (pathArg) guardWritePath(pathArg, { approved: true });
        }
      }
      const shellKey = entry.name === "shell" && args.command ? `shell:${args.command}` : null;
      const shellApproved = permission.allowed === true
        || (entry.name === "shell" && sessionApprovals.has("shell"))
        || (shellKey && sessionApprovals.has(shellKey));
      return entry.run(args, { ...runOptions, shellApproved });
    }
  }));
}

export function toolCatalog({ cwd = process.cwd(), cfg }) {
  const policy = cfg.toolPolicy || {};
  const builtins = createTools({ cwd, cfg: { ...cfg, alwaysApprove: true }, resolveCfg: () => ({ ...cfg, alwaysApprove: true }), confirmTool: async () => true })
    .map((entry) => {
      const fn = entry.schema.function;
      return {
        name: entry.name,
        policy: policy[entry.name] || "ask",
        description: fn.description,
        parameters: Object.keys(fn.parameters?.properties || {}),
        required: fn.parameters?.required || []
      };
    });
  const mcp = listMcpToolCatalog(cfg).map((entry) => ({
    ...entry,
    policy: policy[entry.name] || entry.policy || "ask"
  }));
  return [...builtins, ...mcp];
}

function assertGuard(root, cfg, toolName) {
  if (!["make_dir", "write_file", "edit_file", "copy_path", "move_path", "delete_path", "apply_patch", "shell", "git_commit", "git_worktree"].includes(toolName)) return;
  const result = gitGuard(root, cfg);
  if (!result.ok) throw new Error(result.reason);
}

function tool(name, description, parameters, run) {
  return {
    name,
    run,
    schema: {
      type: "function",
      function: { name, description, parameters }
    }
  };
}

async function approved(name, args, policy, cfg, confirmTool, onApproval = null, permission = null) {
  if (cfg.alwaysApprove) return true;
  const rule = policy[name] || "ask";
  if (rule === "auto") return true;
  if (rule === "deny") {
    onApproval?.({ type: "approval_denied", tool: name, reason: permission?.reason || "policy" });
    return false;
  }
  onApproval?.({ type: "approval_requested", tool: name, args, policyReason: permission?.reason });
  const reasonBit = permission?.reason ? ` (${permission.reason})` : "";
  const question = `Approve tool ${name}${reasonBit} ${JSON.stringify(args).slice(0, 160)}`;
  const ok = confirmTool ? await confirmTool(question) : await confirm(question);
  onApproval?.({ type: ok ? "approval_granted" : "approval_denied", tool: name, args });
  return ok;
}

function safePath(root, requested) {
  const resolved = path.resolve(root, requested || ".");
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return resolved;
}

function sliceLines(text, { startLine, endLine, showLineNumbers = false } = {}) {
  if (!startLine && !endLine && !showLineNumbers) return text;
  const lines = text.split("\n");
  const start = startLine ? Math.max(1, Number(startLine)) : 1;
  const end = endLine ? Math.min(lines.length, Number(endLine)) : lines.length;
  if (start > end) throw new Error(`Invalid line range: ${start}-${end}`);
  return lines
    .slice(start - 1, end)
    .map((line, index) => showLineNumbers ? `${String(start + index).padStart(4)} ${line}` : line)
    .join("\n");
}

function limitLines(text, maxResults) {
  const limit = Math.max(1, Math.min(1000, Number(maxResults) || 200));
  const lines = String(text).split("\n");
  if (lines.length <= limit) return text;
  return `${lines.slice(0, limit).join("\n")}\n... truncated ${lines.length - limit} lines`;
}

function walk(dir, depth, out, base, maxEntries = MAX_LIST_ENTRIES) {
  if (depth < 0 || out.length >= maxEntries) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= maxEntries) return;
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    out.push(path.relative(base, full) + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory()) walk(full, depth - 1, out, base, maxEntries);
  }
}
