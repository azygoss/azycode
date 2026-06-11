import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCustomCommands, resolveCustomCommand } from "../src/commands.js";

test("loadCustomCommands reads markdown prompts with optional frontmatter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-home-"));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-repo-"));
  process.env.AZYCODE_HOME = home;
  fs.mkdirSync(path.join(home, "commands"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".azycode", "commands"), { recursive: true });
  fs.writeFileSync(path.join(home, "commands", "audit.md"), "Audit the repository for risky patterns.", "utf8");
  fs.writeFileSync(path.join(repo, ".azycode", "commands", "review.md"), `---
name: review
description: Local review pass
---
Review the current diff and list findings.
`, "utf8");

  const commands = loadCustomCommands(repo);
  assert.equal(commands.length, 2);
  const review = commands.find((entry) => entry.name === "review");
  assert.match(review.prompt, /Review the current diff/);
  assert.equal(review.description, "Local review pass");
});

test("loadCustomCommands caches until command files change", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-cache-"));
  process.env.AZYCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-cache-home-"));
  fs.mkdirSync(path.join(repo, ".azycode", "commands"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".azycode", "commands", "one.md"), "first", "utf8");
  const first = loadCustomCommands(repo);
  assert.equal(first.length, 1);
  fs.writeFileSync(path.join(repo, ".azycode", "commands", "two.md"), "second", "utf8");
  const second = loadCustomCommands(repo);
  assert.equal(second.length, 2);
});

test("resolveCustomCommand expands args into the prompt", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-resolve-"));
  process.env.AZYCODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "azy-cmd-resolve-home-"));
  fs.mkdirSync(path.join(repo, ".azycode", "commands"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".azycode", "commands", "fix.md"), "Fix the reported issue.", "utf8");

  const resolved = resolveCustomCommand("/fix src/agent.js", repo);
  assert.equal(resolved.name, "fix");
  assert.match(resolved.prompt, /User args: src\/agent\.js/);
  assert.equal(resolveCustomCommand("/missing", repo), null);
});