import assert from "node:assert";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addSkill,
  exportSkill,
  formatSkillsList,
  getSkillRecord,
  getSkillText,
  importSkill,
  listAllSkills,
  listProjectSkills,
  listSkills,
  removeSkill,
  resolveActiveSkills,
  writeProjectSkill
} from "../src/skills.js";
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

test("writeProjectSkill stores markdown skill in repo", () => {
  setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-repo-"));
  const skill = writeProjectSkill(repo, {
    name: "review",
    description: "Review diffs",
    text: "Focus on risky changes.",
    activation: ["review", "diff"]
  });
  assert.equal(skill.scope, "project");
  const project = listProjectSkills(repo);
  assert.equal(project.length, 1);
  assert.equal(project[0].name, "review");
  teardown();
});

test("listAllSkills merges global and project skills with project override", () => {
  setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-merge-"));
  addSkill({ name: "shared", description: "Global", text: "Global text." });
  writeProjectSkill(repo, { name: "shared", description: "Project", text: "Project text." });
  const cfg = loadConfig();
  const items = listAllSkills(cfg, repo);
  const shared = items.find((item) => item.name === "shared");
  assert.equal(shared.scope, "project");
  assert.equal(shared.text, "Project text.");
  teardown();
});

test("resolveActiveSkills activates skills from prompt keywords", () => {
  setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-active-"));
  addSkill({ name: "tests", text: "Write tests.", activation: ["test", "spec"] });
  const cfg = loadConfig();
  const active = resolveActiveSkills(cfg, repo, { prompt: "Please add a spec for cli" });
  assert.equal(active.length, 1);
  assert.equal(active[0].name, "tests");
  teardown();
});

test("getSkillText auto-activates skills when no explicit list is provided", () => {
  setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-auto-"));
  addSkill({ name: "docs", text: "Document changes.", activation: ["readme"] });
  const cfg = loadConfig();
  const text = getSkillText(cfg, [], { cwd: repo, prompt: "update readme section" });
  assert.match(text, /Document changes/);
  teardown();
});

test("exportSkill and importSkill round-trip JSON skills", () => {
  setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "azy-skills-export-"));
  addSkill({ name: "lint", description: "Lint code", text: "Run lint before commit.", tags: ["quality"] });
  const cfg = loadConfig();
  const file = path.join(repo, "lint.skill.json");
  exportSkill("lint", { cfg, cwd: repo, file });
  removeSkill("lint");
  importSkill(file, { cwd: repo });
  const restored = getSkillRecord("lint", loadConfig(), repo);
  assert.equal(restored.description, "Lint code");
  assert.deepEqual(restored.tags, ["quality"]);
  teardown();
});
