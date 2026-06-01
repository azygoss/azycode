import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("source does not reference the removed sibling azy-code repository", () => {
  const files = ["bin", "src", "examples", "README.md", "ARCHITECTURE.md", "package.json"]
    .flatMap((entry) => collectPath(path.join(root, entry)));
  for (const file of files) {
    const rel = path.relative(root, file);
    const text = fs.readFileSync(file, "utf8");
    const removedRepo = ["Documents", "GitHub", "azy-code"].join("/");
    const siblingRepo = ["..", "azy-code"].join("/");
    assert(!text.includes(removedRepo), `${rel} references removed azy-code repository`);
    assert(!text.includes(siblingRepo), `${rel} references sibling azy-code repository`);
  }
});

function collectPath(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const out = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) out.push(...collectPath(full));
    else out.push(full);
  }
  return out;
}
