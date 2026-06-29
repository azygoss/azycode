import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseGitStatusPaths } from "./agent-report.js";

export function localReview(cwd = process.cwd()) {
  // Do not trim status: leading spaces encode porcelain XY columns on each line.
  const status = git(["status", "--short"], cwd).replace(/\s+$/, "");
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
    findings.push(finding("medium", "Dependency or package metadata changed.", "Run install, tests, and package dry-run before shipping.", null, "package-change"));
  }
  if (files.some((file) => /(^|\/)(src|lib|bin)\//.test(file)) && !files.some((file) => /(^|\/)(test|tests)\//.test(file))) {
    findings.push(finding("medium", "Runtime code changed without test changes.", "Add or update targeted tests for the changed behavior.", null, "missing-tests"));
  }
  if (added.length + removed.length > 600) {
    findings.push(finding("medium", "Large local diff.", `${added.length} added and ${removed.length} removed lines; split review by subsystem.`, null, "large-diff"));
  }

  scanAddedLines(added, findings, files);
  scanFiles(files, cwd, findings);

  return { status, files, stats: { added: added.length, removed: removed.length }, findings };
}

function scanAddedLines(added, findings, files) {
  const rules = [
    {
      id: "secret",
      severity: "high",
      title: "Possible secret added.",
      detail: "Inspect added credentials and move secrets to login/env storage.",
      pattern: /api[_-]?key\s*[:=]\s*['"][^'"]{12,}|bearer\s+[a-z0-9._-]{20,}|sk-[a-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[0-9a-zA-Z]{36,}|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----|(?:password|passwd|secret|token|api[_-]?secret)\s*[:=]\s*['"][^'"]{6,}/i
    },
    {
      id: "eval",
      severity: "high",
      title: "Possible code injection pattern.",
      detail: "Avoid eval() and new Function(); they execute arbitrary code.",
      pattern: /eval\s*\(|new\s+Function\s*\(/
    },
    {
      id: "innerhtml",
      severity: "medium",
      title: "Possible XSS via innerHTML.",
      detail: "Prefer textContent or sanitized insertion over direct innerHTML assignment.",
      pattern: /\.innerHTML\s*=/
    },
    {
      id: "exec",
      severity: "medium",
      title: "Unsafe shell execution.",
      detail: "child_process.exec() interpolates a shell; prefer execFile() or execFileSync().",
      pattern: /child_process\.exec\s*\(|require\s*\(\s*['"]child_process['"]\s*\)[\s\S]{0,100}?\bexec\s*\(/
    },
    {
      id: "path-traversal",
      severity: "high",
      title: "Possible path traversal.",
      detail: "Validate and normalize user-controlled paths before filesystem access.",
      pattern: /\.\.(?:\/|\\)|path\.join\([^)]*req\.|(?:readFile(?:Sync)?|readFileSync|writeFile(?:Sync)?|createReadStream)\s*\([^)]*req\./
    },
    {
      id: "unsafe-json",
      severity: "medium",
      title: "Unsafe JSON parsing.",
      detail: "Avoid JSON.parse on untrusted input without validation; consider schema checks.",
      pattern: /JSON\.parse\([^)]*(?:req\.|body|input|user)/i
    },
    {
      id: "insecure-random",
      severity: "medium",
      title: "Insecure random/token generation.",
      detail: "Use crypto.randomBytes or crypto.getRandomValues for tokens, not Math.random.",
      pattern: /Math\.random\(\).*(?:token|secret|password|session|id)/i
    },
    {
      id: "weak-crypto",
      severity: "medium",
      title: "Weak crypto algorithm.",
      detail: "Avoid MD5/SHA1 for security-sensitive hashing; prefer SHA-256+ or dedicated password hashes.",
      pattern: /createHash\(['"]md5['"]\)|createHash\(['"]sha1['"]\)/i
    },
    {
      id: "ssrf",
      severity: "high",
      title: "Possible SSRF-style fetch.",
      detail: "Validate URLs and block internal/metadata endpoints before fetching user input.",
      pattern: /(?:fetch|axios(?:\.get|\.post|\()\s*|node-fetch|http\.request|https\.request|require\s*\(\s*['"]request['"]\s*\)|urllib\.request)\s*\(?[^)]*(?:req\.|params\.|query\.|user|body)/i
    },
    {
      id: "shell-interpolation",
      severity: "high",
      title: "Shell command interpolation.",
      detail: "Never interpolate user input into shell commands; use execFile with argument arrays.",
      pattern: /exec\s*\(\s*[`'"].*\$\{|execSync\s*\(\s*[`'"].*\+/
    },
    {
      id: "unsafe-temp",
      severity: "medium",
      title: "Unsafe temporary file usage.",
      detail: "Use mkdtemp and secure permissions for temp files handling sensitive data.",
      pattern: /\/tmp\/[^'"]*\+|os\.tmpdir\(\).*(?:secret|key|token)/i
    },
    {
      id: "broad-delete",
      severity: "high",
      title: "Broad file deletion pattern.",
      detail: "Confirm recursive deletes are scoped and cannot wipe unexpected paths.",
      pattern: /rmSync\([^)]*recursive:\s*true|fs\.rm\([^)]*force:\s*true|rm\s+-rf/
    },
    {
      id: "todo-marker",
      severity: "low",
      title: "Code markers found in diff.",
      detail: "Review TODO/FIXME/HACK/XXX comments before merging.",
      pattern: /\b(?:TODO|FIXME|HACK|XXX)\b/
    }
  ];

  for (const rule of rules) {
    const hit = added.find((line) => rule.pattern.test(line));
    if (hit) {
      const lineNo = estimateLineNumber(hit);
      findings.push(finding(rule.severity, rule.title, rule.detail, lineNo, rule.id, hit.trim().slice(0, 120)));
    }
  }
}

function scanFiles(files, cwd, findings) {
  for (const file of files) {
    if (/\.github\/workflows\//.test(file)) {
      findings.push(finding("high", "CI workflow changed.", "Review workflow permissions, secrets usage, and third-party actions.", null, "ci-workflow", file));
    }
    if (/(^|\/)package\.json$/.test(file)) {
      const full = path.join(cwd, file);
      if (fs.existsSync(full)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(full, "utf8"));
          const scripts = Object.entries(pkg.scripts || {});
          for (const [name, cmd] of scripts) {
            if (/curl\s+.*\|\s*(?:sh|bash)|rm\s+-rf|eval|wget.*\|/i.test(String(cmd))) {
              findings.push(finding("high", "Risky package script.", `scripts.${name} may execute remote or destructive commands.`, null, "package-script", cmd));
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    }
    if (/(?:^|\/)config\.json$/.test(file)) {
      const full = path.join(cwd, file);
      if (fs.existsSync(full)) {
        try {
          const content = fs.readFileSync(full, "utf8");
          if (/permissionProfile|gitGuard|toolPolicy|alwaysApprove/.test(content)) {
            findings.push(finding("medium", "Permission or guard config changed.", "Verify safety defaults were not weakened unintentionally.", null, "permission-change", file));
          }
        } catch {
          // ignore unreadable config
        }
      }
    }
  }
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
    const loc = item.file ? ` file=${item.file}` : item.line ? ` line≈${item.line}` : "";
    lines.push(`- [${item.severity}] ${item.title}${loc}`);
    lines.push(`  ${item.detail}`);
    if (item.evidence) lines.push(`  evidence: ${item.evidence}`);
    if (item.recommendation) lines.push(`  recommendation: ${item.recommendation}`);
  }
  return lines.join("\n");
}

export function formatLocalReviewJson(review) {
  return {
    changedFiles: review.files,
    stats: review.stats,
    findings: review.findings.map((f) => ({
      severity: f.severity,
      title: f.title,
      detail: f.detail,
      file: f.file || null,
      line: f.line || null,
      id: f.id || null,
      evidence: f.evidence || null
    }))
  };
}

function finding(severity, title, detail, line = null, id = null, evidence = null) {
  return { severity, title, detail, line, id, evidence };
}

function estimateLineNumber(diffLine) {
  const match = diffLine.match(/@@ -\d+(?:,\d+)? \+(\d+)/);
  return match ? Number(match[1]) : null;
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
    const normalized = parseGitStatusPaths(line);
    if (!normalized) continue;
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