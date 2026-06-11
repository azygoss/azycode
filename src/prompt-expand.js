import fs from "node:fs";
import path from "node:path";

const FILE_REF = /(^|\s)@([^\s@]+)/g;
const MAX_FILE_BYTES = 24_000;

export function expandFileReferences(prompt, cwd = process.cwd()) {
  const root = path.resolve(cwd);
  let expanded = String(prompt || "");
  const attachments = [];

  expanded = expanded.replace(FILE_REF, (match, prefix, requested) => {
    const target = safePath(root, requested);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile()) return match;
      const buffer = fs.readFileSync(target).subarray(0, MAX_FILE_BYTES);
      const rel = path.relative(root, target) || requested;
      const text = buffer.toString("utf8");
      attachments.push(rel);
      return `${prefix}\n\n<attached-file path="${rel}">\n${text}\n</attached-file>\n`;
    } catch {
      return match;
    }
  });

  return { prompt: expanded.trim(), attachments };
}

function safePath(root, requested) {
  const resolved = path.resolve(root, requested || ".");
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Path escapes workspace: ${requested}`);
  }
  return resolved;
}