import assert from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addSkill, listSkills, removeSkill, getSkillText, formatSkillsList } from "../src/skills.js";
import { loadConfig, saveConfig, configPath } from "../src/config.js";

let originalHome;

function setup() {
  originalHome = process.env.AZYCODE_HOME;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-"));
  process.env.AZYCODE_HOME = tmp;
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({ version: 1, skills: {} }), { mode: 0o600 });
}

function teardown() {
  if (originalHome) process.env.AZYCODE_HOME = originalHome;
  else delete process.env.AZYCODE_HOME;
}

test("listSkills returns empty when no skills", () => {
  setup();
  const cfg = loadConfig();
  assert.deepEqual(listSkills(cfg), []);
  teardown();
});

test("addSkill creates a skill", () => {
  setup();
  addSkill({ name: "testing", description: "Write tests", text: "Always write tests for new code." });
  const cfg = loadConfig();
  assert.equal(cfg.skills.testing.description, "Write tests");
  assert.equal(cfg.skills.testing.text, "Always write tests for new code.");
  teardown();
});

test("listSkills returns added skills", () => {
  setup();
  addSkill({ name: "refactor", description: "Refactor", text: "Keep it clean." });
  addSkill({ name: "docs", description: "Document", text: "Add docs." });
  const cfg = loadConfig();
  const items = listSkills(cfg);
  assert.equal(items.length, 2);
  assert.ok(items.find((s) => s.name === "refactor"));
  assert.ok(items.find((s) => s.name === "docs"));
  teardown();
});

test("removeSkill deletes a skill", () => {
  setup();
  addSkill({ name: "temp", description: "Temp", text: "Temp skill." });
  removeSkill("temp");
  const cfg = loadConfig();
  assert.equal(cfg.skills.temp, undefined);
  teardown();
});

test("removeSkill throws for missing skill", () => {
  setup();
  assert.throws(() => removeSkill("missing"), /No skill named/);
  teardown();
});

test("addSkill validates name format", () => {
  setup();
  assert.throws(() => addSkill({ name: "123bad", text: "x" }), /Skill name must start with a letter/);
  teardown();
});

test("getSkillText returns combined skill text", () => {
  setup();
  addSkill({ name: "a", text: "Skill A content." });
  addSkill({ name: "b", text: "Skill B content." });
  const cfg = loadConfig();
  const text = getSkillText(cfg, ["a", "b"]);
  assert.match(text, /Skill A content/);
  assert.match(text, /Skill B content/);
  teardown();
});

test("getSkillText ignores missing skills", () => {
  setup();
  addSkill({ name: "a", text: "Skill A." });
  const cfg = loadConfig();
  const text = getSkillText(cfg, ["a", "missing"]);
  assert.match(text, /Skill A/);
  assert.doesNotMatch(text, /missing/);
  teardown();
});

test("getSkillText returns empty for empty names", () => {
  setup();
  const cfg = loadConfig();
  assert.equal(getSkillText(cfg, []), "");
  assert.equal(getSkillText(cfg, null), "");
  teardown();
});

test("formatSkillsList formats items", () => {
  const items = [
    { name: "test", description: "Testing" },
    { name: "doc", description: "" }
  ];
  const out = formatSkillsList(items);
  assert.match(out, /test · Testing/);
  assert.match(out, /doc$/m);
});

test("formatSkillsList returns placeholder when empty", () => {
  assert.equal(formatSkillsList([]), "No skills.");
});
