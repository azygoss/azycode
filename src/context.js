import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const DEFAULT_IGNORE = [
  ".git", "node_modules", "dist", "coverage", ".DS_Store",
  ".env", ".env.local", ".env.production", ".env.development",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
  ".next", ".nuxt", ".svelte-kit", ".astro", ".vinxi",
  ".cache", ".turbo", ".vercel", ".output",
  "build", "out", "target", "tmp", "temp",
  ".idea", ".vscode",
  "*.log"
];

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

function isDefaultIgnored(name) {
  return [".git", "node_modules", "dist", "coverage", ".DS_Store",
    ".next", ".nuxt", ".svelte-kit", ".astro", ".vinxi",
    ".cache", ".turbo", ".vercel", ".output",
    "build", "out", "target", "tmp", "temp",
    ".idea", ".vscode"].includes(name);
}

function walk(root, dir, depth, out) {
  if (depth < 0) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isDefaultIgnored(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    out.push(entry.isDirectory() ? `${rel}/` : rel);
    if (entry.isDirectory()) walk(root, full, depth - 1, out);
  }
}

function listConfigFiles(root) {
  const names = [
    "AGENTS.md", "README.md", ".azycode/rules.md",
    "package.json", "pyproject.toml", "Cargo.toml", "tsconfig.json",
    "vite.config.ts", "vite.config.js", "webpack.config.js",
    "jest.config.js", "jest.config.ts", ".eslintrc.json", ".eslintrc.js",
    ".prettierrc", ".prettierrc.json", "docker-compose.yml", "Dockerfile",
    "Makefile", "CMakeLists.txt", "go.mod", "requirements.txt"
  ];
  return names.filter((name) => fs.existsSync(path.join(root, name)));
}

let _contextCacheKey = "";
let _contextCacheValue = null;

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function contextCacheKey(cwd, options = {}) {
  const root = path.resolve(cwd);
  const maxFiles = Number(options.maxFiles) || 40;
  const maxBytes = Number(options.maxBytes) || 80000;
  const parts = [
    root,
    String(maxFiles),
    String(maxBytes),
    fileMtime(path.join(root, ".azyignore")),
    fileMtime(path.join(root, "package.json")),
    fileMtime(path.join(root, "README.md")),
    fileMtime(path.join(root, "AGENTS.md"))
  ];
  try {
    const head = path.join(root, ".git", "HEAD");
    parts.push(String(fileMtime(head)));
    const ref = fs.readFileSync(head, "utf8").trim();
    if (ref.startsWith("ref: ")) {
      parts.push(String(fileMtime(path.join(root, ".git", ref.slice(5)))));
    }
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    parts.push(status.slice(0, 4000));
  } catch {
    // non-git workspace
  }
  return parts.join("|");
}

export function clearContextPackCache() {
  _contextCacheKey = "";
  _contextCacheValue = null;
}

export async function contextPack(cwd = process.cwd(), options = {}) {
  const cacheKey = contextCacheKey(cwd, options);
  if (_contextCacheKey === cacheKey) return _contextCacheValue;
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
    const content = await fs.promises.readFile(full, "utf8");
    selected.push({ file, content });
    usedBytes += stat.size;
  }
  const pack = { root, files: selected, usedBytes, ignored: ignore };
  _contextCacheKey = cacheKey;
  _contextCacheValue = pack;
  return pack;
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
