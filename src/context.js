import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_IGNORE = [".git", "node_modules", "dist", "coverage", ".DS_Store", "package-lock.json"];

export function repoSnapshot(cwd = process.cwd()) {
  const root = path.resolve(cwd);
  return {
    root,
    package: readPackage(root),
    git: gitInfo(root),
    files: listFiles(root, 3),
    configFiles: listConfigFiles(root)
  };
}

export function formatSnapshot(snapshot) {
  const lines = [];
  lines.push(`root: ${snapshot.root}`);
  if (snapshot.package) {
    lines.push(`package: ${snapshot.package.name || "(unnamed)"} ${snapshot.package.version || ""}`.trim());
    lines.push(`scripts: ${Object.keys(snapshot.package.scripts || {}).join(", ") || "(none)"}`);
  }
  lines.push(`gitRoot: ${snapshot.git.root || "(not a git repo)"}`);
  lines.push(`branch: ${snapshot.git.branch || "(none)"}`);
  lines.push(`changedFiles: ${snapshot.git.changedFiles.length}`);
  if (snapshot.configFiles.length) lines.push(`config: ${snapshot.configFiles.join(", ")}`);
  lines.push("files:");
  for (const file of snapshot.files) lines.push(`  ${file}`);
  return lines.join("\n");
}

function readPackage(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function gitInfo(root) {
  try {
    const options = { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
    const branch = execFileSync("git", ["branch", "--show-current"], options).trim();
    const changed = execFileSync("git", ["status", "--short"], options).trim();
    return {
      root: gitRoot,
      branch,
      changedFiles: changed ? changed.split(/\r?\n/) : []
    };
  } catch {
    return { root: null, branch: null, changedFiles: [] };
  }
}

function listFiles(root, depth) {
  const out = [];
  walk(root, root, depth, out);
  return out.slice(0, 300);
}

function walk(root, dir, depth, out) {
  if (depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules", "dist", "coverage"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) walk(root, full, depth - 1, out);
  }
}

function listConfigFiles(root) {
  const names = ["AGENTS.md", "README.md", ".azycode/rules.md", "package.json", "pyproject.toml", "Cargo.toml"];
  return names.filter((name) => fs.existsSync(path.join(root, name)));
}

export function contextPack(cwd = process.cwd(), options = {}) {
  const root = path.resolve(cwd);
  const maxFiles = Number(options.maxFiles) || 40;
  const maxBytes = Number(options.maxBytes) || 80000;
  const ignore = loadIgnore(root);
  const files = [];
  collectPackFiles(root, root, ignore, files);
  const selected = [];
  let usedBytes = 0;
  for (const file of rankFiles(files)) {
    if (selected.length >= maxFiles) break;
    const full = path.join(root, file);
    const stat = fs.statSync(full);
    if (stat.size > Math.min(maxBytes, 120000)) continue;
    if (usedBytes + stat.size > maxBytes) break;
    selected.push({ file, content: fs.readFileSync(full, "utf8") });
    usedBytes += stat.size;
  }
  return { root, files: selected, usedBytes, ignored: ignore };
}

export function formatContextPack(pack) {
  const lines = [
    `Context Pack`,
    `root: ${pack.root}`,
    `files: ${pack.files.length}`,
    `bytes: ${pack.usedBytes}`,
    ""
  ];
  for (const item of pack.files) {
    lines.push(`--- ${item.file} ---`);
    lines.push(item.content);
    if (!item.content.endsWith("\n")) lines.push("");
  }
  return lines.join("\n");
}

function collectPackFiles(root, dir, ignore, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (ignored(rel, entry, ignore)) continue;
    if (entry.isDirectory()) {
      collectPackFiles(root, full, ignore, out);
    } else if (isTextCandidate(rel)) {
      out.push(rel);
    }
  }
}

function loadIgnore(root) {
  const ignore = new Set(DEFAULT_IGNORE);
  const file = path.join(root, ".azyignore");
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) ignore.add(trimmed.replace(/\/+$/, ""));
    }
  }
  return [...ignore];
}

function ignored(rel, entry, ignore) {
  return ignore.some((pattern) => {
    return rel === pattern || rel.startsWith(`${pattern}/`) || entry.name === pattern;
  });
}

function isTextCandidate(file) {
  return /\.(js|ts|jsx|tsx|json|md|yml|yaml|toml|txt|sh|py|rs|go|java|c|cc|cpp|h|css|html)$/.test(file)
    || ["Dockerfile", "Makefile"].includes(path.basename(file));
}

function rankFiles(files) {
  const priority = ["AGENTS.md", "README.md", "package.json", "src/", "bin/", "test/"];
  return [...files].sort((a, b) => score(a, priority) - score(b, priority) || a.localeCompare(b));
}

function score(file, priority) {
  const index = priority.findIndex((item) => file === item || file.startsWith(item));
  return index === -1 ? priority.length : index;
}
