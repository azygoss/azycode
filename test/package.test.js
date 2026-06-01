import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

test("npm package contains only standalone azycode source files", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8" });
  const [pack] = JSON.parse(output);
  const files = pack.files.map((file) => file.path).sort();
  assert(files.includes("bin/azycode.js"));
  assert(files.includes("src/cli.js"));
  assert(files.includes("src/llm.js"));
  const removedRepo = ["Documents", "GitHub", "azy-code"].join("/");
  assert(!files.some((file) => file.includes(removedRepo)));
  assert(!files.some((file) => file.startsWith("work/")));
  for (const file of files) {
    const full = path.join(root, file);
    if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) continue;
    const text = fs.readFileSync(full, "utf8");
    assert(!text.includes(removedRepo), `${file} references removed repository`);
  }
});
