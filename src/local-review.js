import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function localReview(cwd = process.cwd()) {
  const status = git(["status", "--short"], cwd).trim();
  const diff = git(["diff", "--no-ext-diff"], cwd);
  const staged = git(["diff", "--cached", "--no-ext-diff"], cwd);
  const combined = [diff, staged].filter(Boolean).join("\n");
  const findings = [];
  const lines = combined.split(/\r?\n/);
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++"));
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---"));
  const files = changedFiles(status, combined, cwd);

  if (!status) findings.push(finding("info", "No local git changes detected.", "Working tree has no tracked or untracked changes."));
  if (files.some((file) => /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file))) {
    findings.push(finding("medium", "Dependency or package metadata changed.", "Run install, tests, and package dry-run before shipping."));
  }
  if (files.some((file) => /(^|\/)(src|lib|bin)\//.test(file)) && !files.some((file) => /(^|\/)(test|tests)\//.test(file))) {
    findings.push(finding("medium", "Runtime code changed without test changes.", "Add or update targeted tests for the changed behavior."));
  }
  if (added.length + removed.length > 600) {
    findings.push(finding("medium", "Large local diff.", `${added.length} added and ${removed.length} removed lines; split review by subsystem.`));
  }
  if (added.some((line) => /api[_-]?key\s*[:=]\s*['"][^'"]{12,}|bearer\s+[a-z0-9._-]{20,}|sk-[a-z0-9_-]{16,}/i.test(line))) {
    findings.push(finding("high", "Possible secret added.", "Inspect added credentials and move secrets to login/env storage."));
  }
  if (added.some((line) => /eval\s*\(|new\s+Function\s*\(/.test(line))) {
    findings.push(finding("high", "Possible code injection pattern.", "Avoid eval() and new Function(); they execute arbitrary code."));
  }
  if (added.some((line) => /\.innerHTML\s*=/.test(line))) {
    findings.push(finding("medium", "Possible XSS via innerHTML.", "Prefer textContent or sanitized insertion over direct innerHTML assignment."));
  }
  if (added.some((line) => /child_process\.exec\s*\(|require\s*\(\s*['"]child_process['"]\s*\)[\s\S]{0,100}?\bexec\s*\(/.test(line))) {
    findings.push(finding("medium", "Unsafe shell execution.", "child_process.exec() interpolates a shell; prefer execFile() or execFileSync()."));
  }
  if (added.some((line) => /\b(?:TODO|FIXME|HACK|XXX)\b/.test(line))) {
    findings.push(finding("low", "Code markers found in diff.", "Review TODO/FIXME/HACK/XXX comments before merging."));
  }

  return { status, files, stats: { added: added.length, removed: removed.length }, findings };
}

export function formatLocalReview(review) {
  const lines = [
    "Local Review",
    `changedFiles: ${review.files.length}`,
    `diffStats: +${review.stats.added} -${review.stats.removed}`
  ];
  if (!review.findings.length) return [...lines, "findings: none"].join("\n");
  lines.push("findings:");
  for (const item of review.findings) {
    lines.push(`- [${item.severity}] ${item.title}`);
    lines.push(`  ${item.detail}`);
  }
  return lines.join("\n");
}

function finding(severity, title, detail) {
  return { severity, title, detail };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function changedFiles(status, diff, cwd = process.cwd()) {
  const files = new Set();
  for (const line of status.split(/\r?\n/)) {
    const file = line.slice(3).trim();
    if (!file) continue;
    const normalized = file.replace(/^"|"$/g, "");
    const full = path.join(cwd, normalized);
    if (line.startsWith("??") && fs.existsSync(full) && fs.statSync(full).isDirectory()) {
      for (const nested of walkFiles(full, cwd)) files.add(nested);
    } else {
      files.add(normalized);
    }
  }
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (match) files.add(match[2]);
  }
  return [...files].sort();
}

function walkFiles(dir, root) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(full, root));
    else out.push(path.relative(root, full));
  }
  return out;
}
