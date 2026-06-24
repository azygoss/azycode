import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  ContextBuilder,
  classifyContextSection,
  clearContextPackCache,
  contextPack,
  extractJsSymbols,
  formatContextPack,
  formatSnapshot,
  getContextMutationGeneration,
  notifyContextWorkspaceMutation,
  repoSnapshot,
  shouldInvalidateContextForShell
} from "../src/context.js";

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-ctx-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "t@t.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "T"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", version: "1.0.0", scripts: { test: "node --test" } }));
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "index.js"), "export const x = 1;\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

test("repoSnapshot captures package, git, files, and config files", () => {
  const dir = makeRepo();
  const snap = repoSnapshot(dir);
  assert.equal(snap.package.name, "demo");
  assert.equal(snap.package.version, "1.0.0");
  assert.ok(snap.git.root, "git root should be detected");
  assert.ok(snap.git.branch, "branch should be detected");
  assert.ok(snap.files.some((f) => f.includes("src/index.js")), "files should list src/index.js");
  assert.ok(snap.configFiles.includes("package.json"));
  assert.ok(snap.configFiles.includes("README.md"));
});

test("repoSnapshot on empty dir degrades gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-empty-"));
  const snap = repoSnapshot(dir);
  assert.equal(snap.package, null);
  assert.equal(snap.git.root, null);
  assert.equal(snap.git.branch, null);
  assert.deepEqual(snap.git.changedFiles, []);
  assert.ok(Array.isArray(snap.files));
  assert.ok(Array.isArray(snap.configFiles));
});

test("repoSnapshot ignores default directories (node_modules, .git, dist)", () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "pkg.js"), "x");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "out.js"), "x");
  const snap = repoSnapshot(dir);
  const listed = snap.files.join("\n");
  assert.equal(listed.includes("node_modules"), false);
  assert.equal(listed.includes("dist"), false);
});

test("formatSnapshot renders a readable summary", () => {
  const dir = makeRepo();
  const text = formatSnapshot(repoSnapshot(dir));
  assert.match(text, /root:/);
  assert.match(text, /package: demo 1\.0\.0/);
  assert.match(text, /branch:/);
  assert.match(text, /files:/);
});

test("classifyContextSection maps reasons to budgeted sections", () => {
  assert.equal(classifyContextSection({ reason: "AGENTS.md config file" }), "instructions");
  assert.equal(classifyContextSection({ reason: "in git diff" }), "changed");
  assert.equal(classifyContextSection({ reason: "prompt mention" }), "promptMentions");
  assert.equal(classifyContextSection({ reason: "import neighbor" }), "neighbors");
  assert.equal(classifyContextSection({ reason: "test for index.js" }), "tests");
  assert.equal(classifyContextSection({ reason: "keyword search match" }), "search");
  assert.equal(classifyContextSection({ reason: "recent mtime" }), "recent");
  assert.equal(classifyContextSection({ reason: "misc" }), "general");
});

test("shouldInvalidateContextForShell detects mutating commands", () => {
  assert.equal(shouldInvalidateContextForShell("npm test"), true);
  assert.equal(shouldInvalidateContextForShell("npm run build"), true);
  assert.equal(shouldInvalidateContextForShell("git commit -m x"), true);
  assert.equal(shouldInvalidateContextForShell("git status"), false);
  assert.equal(shouldInvalidateContextForShell("ls -la"), false);
});

test("notifyContextWorkspaceMutation bumps generation and clears cache", () => {
  const before = getContextMutationGeneration();
  const result = notifyContextWorkspaceMutation("write", "src/x.js");
  assert.ok(result.generation > before);
  assert.equal(getContextMutationGeneration(), result.generation);
});

test("extractJsSymbols parses exports and named re-exports", () => {
  const code = [
    "import { a } from 'mod';",
    "export const x = 1;",
    "export function foo() {}",
    "class Bar {}",
    "export { Bar }"
  ].join("\n");
  const symbols = extractJsSymbols(code);
  assert.ok(Array.isArray(symbols), "extractJsSymbols returns an array of export names");
  assert.ok(symbols.includes("x"), "named const export should be detected");
  assert.ok(symbols.includes("foo"), "function export should be detected");
  assert.ok(symbols.includes("Bar"), "re-exported name should be detected");
});

test("ContextBuilder collects candidates and groups into sections", async () => {
  const dir = makeRepo();
  const builder = new ContextBuilder(dir);
  builder.addCandidate("src/index.js", "AGENTS.md config file", 80);
  builder.addCandidate("src/index.js", "keyword search match", 40);
  const items = await builder.build();
  assert.ok(Array.isArray(items));
  assert.ok(items.some((i) => i.file.replace(/\\/g, "/").endsWith("src/index.js")));
});

test("contextPack produces a context-pack with untrusted-data wrapper", async () => {
  const dir = makeRepo();
  clearContextPackCache();
  const pack = await contextPack(dir, { maxFiles: 20, maxBytes: 20000 });
  assert.ok(Array.isArray(pack.files));
  assert.ok(pack.usedBytes >= 0);
  const formatted = formatContextPack(pack);
  assert.match(formatted, /<context-pack>/);
  assert.match(formatted, /<untrusted-data>/);
  assert.match(formatted, /<\/context-pack>/);
  assert.match(formatted, /<repo-summary>/);
});

test("contextPack caches result until invalidated", async () => {
  const dir = makeRepo();
  clearContextPackCache();
  const first = await contextPack(dir, { maxFiles: 10, maxBytes: 10000 });
  const second = await contextPack(dir, { maxFiles: 10, maxBytes: 10000 });
  assert.equal(second, first, "identical options must return cached object");
  notifyContextWorkspaceMutation("write", "src/x.js");
  const third = await contextPack(dir, { maxFiles: 10, maxBytes: 10000 });
  assert.notEqual(third, first, "mutation must invalidate cache");
});

test("contextPack respects .azyignore", async () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "secrets", "key.js"), "export const SECRET='x';\n");
  fs.writeFileSync(path.join(dir, ".azyignore"), "secrets\n");
  clearContextPackCache();
  const pack = await contextPack(dir, { maxFiles: 40, maxBytes: 40000 });
  const listed = pack.files.map((f) => f.file).join("\n");
  assert.equal(listed.includes("secrets/"), false, ".azyignore must exclude the secrets dir");
});

test("formatContextPack marks AGENTS.md as trusted instruction file", async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Rules\nUse strict mode.\n");
  clearContextPackCache();
  const pack = await contextPack(dir, { maxFiles: 40, maxBytes: 40000 });
  const formatted = formatContextPack(pack);
  assert.match(formatted, /<trusted-instruction-file[^>]*path="AGENTS\.md"/);
});
