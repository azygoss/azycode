import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { confirm } from "./prompt.js";
import { gitGuard } from "./guard.js";

const execFileAsync = promisify(execFile);

export function createTools({ cwd = process.cwd(), cfg, confirmTool = null }) {
  const root = path.resolve(cwd);
  const policy = cfg.toolPolicy || {};
  const tools = [
    tool("list_files", "List files below a directory.", {
      type: "object",
      properties: { dir: { type: "string" }, depth: { type: "number" } }
    }, async ({ dir = ".", depth = 2 }) => {
      const base = safePath(root, dir);
      const out = [];
      walk(base, Number(depth) || 2, out, base);
      return out.join("\n");
    }),
    tool("read_file", "Read a UTF-8 text file.", {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"]
    }, async ({ file }) => fs.readFileSync(safePath(root, file), "utf8")),
    tool("search", "Search text in files using ripgrep when available.", {
      type: "object",
      properties: { query: { type: "string" }, dir: { type: "string" } },
      required: ["query"]
    }, async ({ query, dir = "." }) => {
      const base = safePath(root, dir);
      try {
        const { stdout } = await execFileAsync("rg", ["--line-number", "--hidden", "--glob", "!node_modules", query, base], { timeout: 20000 });
        return stdout || "(no matches)";
      } catch (error) {
        if (error.stdout) return error.stdout;
        return "(no matches)";
      }
    }),
    tool("write_file", "Write a UTF-8 text file. Creates parent directories.", {
      type: "object",
      properties: { file: { type: "string" }, content: { type: "string" } },
      required: ["file", "content"]
    }, async ({ file, content }) => {
      assertGuard(root, cfg, "write_file");
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
      assertGuard(root, cfg, "edit_file");
      const target = safePath(root, file);
      const original = fs.readFileSync(target, "utf8");
      if (!original.includes(search)) throw new Error(`Search text not found in ${file}`);
      const next = original.replace(search, replace);
      fs.writeFileSync(target, next, "utf8");
      return `edited ${path.relative(root, target)}`;
    }),
    tool("apply_patch", "Apply a unified diff patch to the workspace using git apply.", {
      type: "object",
      properties: {
        patch: { type: "string" },
        checkOnly: { type: "boolean" }
      },
      required: ["patch"]
    }, async ({ patch, checkOnly = false }) => {
      if (!checkOnly) assertGuard(root, cfg, "apply_patch");
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
    tool("shell", "Run a shell command in the workspace. Use for tests and build commands.", {
      type: "object",
      properties: { command: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["command"]
    }, async ({ command, timeoutMs = 60000 }) => {
      assertGuard(root, cfg, "shell");
      const { stdout, stderr } = await execFileAsync(process.env.SHELL || "sh", ["-lc", command], {
        cwd: root,
        timeout: Number(timeoutMs) || 60000,
        maxBuffer: 1024 * 1024 * 8
      });
      return [stdout, stderr].filter(Boolean).join("\n") || "(no output)";
    })
  ];

  return tools.map((entry) => ({
    ...entry,
    run: async (args) => {
      if (!(await approved(entry.name, args, policy, cfg, confirmTool))) {
        return "Tool call rejected by user.";
      }
      return entry.run(args);
    }
  }));
}

function assertGuard(root, cfg, toolName) {
  if (!["write_file", "edit_file", "apply_patch", "shell"].includes(toolName)) return;
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

function walk(dir, depth, out, base) {
  if (depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    out.push(path.relative(base, full) + (entry.isDirectory() ? "/" : ""));
    if (entry.isDirectory()) walk(full, depth - 1, out, base);
  }
}
