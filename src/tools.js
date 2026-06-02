import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confirm } from "./prompt.js";
import { gitGuard, validateBranchName } from "./guard.js";
import { runTodoAction } from "./todos.js";

const execFileAsync = promisify(execFile);

export function createTools({ cwd = process.cwd(), cfg, resolveCfg = null, confirmTool = null, modeRuntime = null }) {
  const root = path.resolve(cwd);
  const policySource = resolveCfg || (() => cfg);
  const policy = () => policySource().toolPolicy || {};
  const tools = [
    tool("list_files", "List files below a directory.", {
      type: "object",
      properties: { dir: { type: "string" }, depth: { type: "number" } }
    }, async ({ dir = ".", depth = 2 }) => {
      const base = safePath(root, dir);
      const out = [];
      walk(base, Math.max(0, Number(depth) || 2), out, base);
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
      const text = fs.readFileSync(safePath(root, file), "utf8").slice(0, limit);
      return sliceLines(text, { startLine, endLine, showLineNumbers });
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
      return selected.map((file) => {
        const target = safePath(root, file);
        const text = fs.readFileSync(target, "utf8").slice(0, limit);
        return `--- ${file} ---\n${text}`;
      }).join("\n\n");
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
    tool("search", "Search text in files using ripgrep when available.", {
      type: "object",
      properties: {
        query: { type: "string" },
        dir: { type: "string" },
        maxResults: { type: "number" },
        contextLines: { type: "number" }
      },
      required: ["query"]
    }, async ({ query, dir = ".", maxResults = 200, contextLines = 0 }) => {
      const base = safePath(root, dir);
      try {
        const args = ["--line-number", "--hidden", "--glob", "!node_modules"];
        const context = Math.max(0, Math.min(5, Number(contextLines) || 0));
        if (context) args.push("--context", String(context));
        args.push(query, base);
        const { stdout } = await execFileAsync("rg", args, { timeout: 20000, maxBuffer: 1024 * 1024 * 8 });
        return limitLines(stdout || "(no matches)", Number(maxResults) || 200);
      } catch (error) {
        if (error.stdout) return limitLines(error.stdout, Number(maxResults) || 200);
        if (error.code === "ENOENT") {
          try {
            const { stdout } = await execFileAsync("grep", ["-rn", "--exclude-dir=node_modules", query, base], { timeout: 20000, maxBuffer: 1024 * 1024 * 8 });
            return limitLines(stdout || "(no matches)", Number(maxResults) || 200);
          } catch (grepError) {
            if (grepError.stdout) return limitLines(grepError.stdout, Number(maxResults) || 200);
            return "(no matches)";
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
      const target = safePath(root, dir);
      fs.mkdirSync(target, { recursive: true });
      return `created ${path.relative(root, target) || "."}`;
    }),
    tool("write_file", "Write a UTF-8 text file. Creates parent directories.", {
      type: "object",
      properties: { file: { type: "string" }, content: { type: "string" } },
      required: ["file", "content"]
    }, async ({ file, content }) => {
      assertGuard(root, policySource(), "write_file");
      const target = safePath(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, "utf8");
      return `wrote ${path.relative(root, target)}`;
    }),
    tool("edit_file", "Replace exact text in a UTF-8 file.", {
      type: "object",
      properties: {
        file: { type: "string" },
        search: { type: "string" },
        replace: { type: "string" }
      },
      required: ["file", "search", "replace"]
    }, async ({ file, search, replace }) => {
      assertGuard(root, policySource(), "edit_file");
      const target = safePath(root, file);
      const original = fs.readFileSync(target, "utf8");
      if (!original.includes(search)) throw new Error(`Search text not found in ${file}`);
      const next = original.replace(search, replace);
      fs.writeFileSync(target, next, "utf8");
      return `edited ${path.relative(root, target)}`;
    }),
    tool("copy_path", "Copy a file or directory inside the workspace.", {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }, async ({ from, to }) => {
      assertGuard(root, policySource(), "copy_path");
      const source = safePath(root, from);
      const target = safePath(root, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(source, target, { recursive: true, force: true });
      return `copied ${path.relative(root, source)} -> ${path.relative(root, target)}`;
    }),
    tool("move_path", "Move or rename a file or directory inside the workspace.", {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"]
    }, async ({ from, to }) => {
      assertGuard(root, policySource(), "move_path");
      const source = safePath(root, from);
      const target = safePath(root, to);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.renameSync(source, target);
      return `moved ${path.relative(root, source)} -> ${path.relative(root, target)}`;
    }),
    tool("delete_path", "Delete a file or directory inside the workspace.", {
      type: "object",
      properties: { path: { type: "string" }, recursive: { type: "boolean" } },
      required: ["path"]
    }, async ({ path: requested, recursive = false }) => {
      assertGuard(root, policySource(), "delete_path");
      const target = safePath(root, requested);
      if (target === root) throw new Error("Refusing to delete workspace root.");
      fs.rmSync(target, { recursive: Boolean(recursive), force: false });
      return `deleted ${path.relative(root, target)}`;
    }),
    tool("apply_patch", "Apply a unified diff patch to the workspace using git apply.", {
      type: "object",
      properties: {
        patch: { type: "string" },
        checkOnly: { type: "boolean" }
      },
      required: ["patch"]
    }, async ({ patch, checkOnly = false }) => {
      if (!checkOnly) assertGuard(root, policySource(), "apply_patch");
      const temp = path.join(os.tmpdir(), `azycode-patch-${process.pid}-${Date.now()}.diff`);
      fs.writeFileSync(temp, patch, "utf8");
      try {
        await execFileAsync("git", ["apply", "--check", temp], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 4 });
        if (checkOnly) return "patch check ok";
        await execFileAsync("git", ["apply", temp], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 4 });
        return "patch applied";
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }),
    tool("git_diff", "Show git diff for the workspace.", {
      type: "object",
      properties: { staged: { type: "boolean" } }
    }, async ({ staged = false }) => {
      const args = staged ? ["diff", "--staged"] : ["diff"];
      const { stdout } = await execFileAsync("git", args, { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 8 });
      return stdout || "(no diff)";
    }),
    tool("git_status", "Show short git status for the workspace.", {
      type: "object",
      properties: {}
    }, async () => {
      const { stdout } = await execFileAsync("git", ["status", "--short", "--branch"], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 2 });
      return stdout || "(clean)";
    }),
    tool("git_log", "Show recent git commits.", {
      type: "object",
      properties: { limit: { type: "number" } }
    }, async ({ limit = 10 }) => {
      const count = Math.max(1, Math.min(50, Number(limit) || 10));
      const { stdout } = await execFileAsync("git", ["log", `-${count}`, "--oneline", "--decorate"], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 2 });
      return stdout || "(no commits)";
    }),
    tool("git_show", "Show a git object, commit, or file at a revision.", {
      type: "object",
      properties: { rev: { type: "string" }, file: { type: "string" } },
      required: ["rev"]
    }, async ({ rev, file = "" }) => {
      const spec = file ? `${rev}:${path.relative(root, safePath(root, file))}` : rev;
      const { stdout } = await execFileAsync("git", ["show", "--stat", "--patch", spec], { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 8 });
      return stdout || "(no output)";
    }),
    tool("git_checkout", "Switch or create a git branch. Works on gitGuard-protected branches (unlike shell). Use create:true to run git checkout -b.", {
      type: "object",
      properties: {
        branch: { type: "string" },
        create: { type: "boolean" }
      },
      required: ["branch"]
    }, async ({ branch, create = false }) => {
      const name = validateBranchName(branch);
      const args = create ? ["checkout", "-b", name] : ["checkout", name];
      const { stdout, stderr } = await execFileAsync("git", args, { cwd: root, timeout: 20000, maxBuffer: 1024 * 1024 * 2 });
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
    }, async ({ command, timeoutMs = 60000 }) => {
      assertGuard(root, policySource(), "shell");
      const { stdout, stderr } = await execFileAsync(process.env.SHELL || "sh", ["-lc", command], {
        cwd: root,
        timeout: Math.max(1, Number(timeoutMs) || 60000),
        maxBuffer: 1024 * 1024 * 8
      });
      return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
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
    ...(modeRuntime ? [tool("set_mode", "Switch harness mode for the rest of this agent run. Use plan before risky edits; use always-approve or goal to implement.", {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plan", "always-approve", "goal", "review"] },
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
    run: async (args) => {
      const activeCfg = policySource();
      if (!(await approved(entry.name, args, policy(), activeCfg, confirmTool))) {
        return "Tool call rejected by user.";
      }
      return entry.run(args);
    }
  }));
}

export function toolCatalog({ cwd = process.cwd(), cfg }) {
  const policy = cfg.toolPolicy || {};
  return createTools({ cwd, cfg: { ...cfg, alwaysApprove: true }, resolveCfg: () => ({ ...cfg, alwaysApprove: true }), confirmTool: async () => true })
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
}

function assertGuard(root, cfg, toolName) {
  if (!["make_dir", "write_file", "edit_file", "copy_path", "move_path", "delete_path", "apply_patch", "shell"].includes(toolName)) return;
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

async function approved(name, args, policy, cfg, confirmTool) {
  if (cfg.alwaysApprove) return true;
  const rule = policy[name] || "ask";
  if (rule === "auto") return true;
  if (rule === "deny") return false;
  const question = `Approve tool ${name} ${JSON.stringify(args).slice(0, 180)}`;
  return confirmTool ? confirmTool(question) : confirm(question);
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

function walk(dir, depth, out, base) {
  if (depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    out.push(path.relative(base, full) + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory()) walk(full, depth - 1, out, base);
  }
}
