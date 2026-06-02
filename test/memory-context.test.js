import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addMemory, removeMemory, searchMemory } from "../src/memory.js";
import { contextPack, formatContextPack, formatSnapshot, repoSnapshot } from "../src/context.js";

test("memory add/search/remove works in isolated AZYCODE_HOME", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-memory-"));
  process.env.AZYCODE_HOME = home;
  const note = addMemory("Prefer small verified patches", ["workflow"]);
  assert.equal(searchMemory("verified").length, 1);
  assert.equal(searchMemory("please use a verified patch workflow")[0].id, note.id);
  assert.equal(searchMemory("workflow")[0].id, note.id);
  assert.equal(removeMemory(note.id), true);
  assert.equal(searchMemory("").length, 0);
});

test("repo snapshot summarizes files and package scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-context-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node test.js" } }));
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('x')\n");
  const snapshot = repoSnapshot(dir);
  const formatted = formatSnapshot(snapshot);
  assert.equal(snapshot.package.name, "demo");
  assert(snapshot.files.includes("src/index.js"));
  assert.match(formatted, /scripts: test/);
});

test("contextPack respects .azyignore and formats selected files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-context-"));
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(dir, "secret.txt"), "secret\n");
  fs.writeFileSync(path.join(dir, ".azyignore"), "secret.txt\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "index.js"), "console.log('x')\n");
  const pack = await contextPack(dir, { maxFiles: 10, maxBytes: 2000 });
  assert(pack.files.some((item) => item.file === "README.md"));
  assert(pack.files.some((item) => item.file === "src/index.js"));
  assert(!pack.files.some((item) => item.file === "secret.txt"));
  assert.match(formatContextPack(pack), /Context Pack/);
});
