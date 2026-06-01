import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatMissionPlan, loadMission, missionPlan } from "../src/missions.js";

test("loads tiny yaml mission", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-mission-"));
  const file = path.join(dir, "mission.yml");
  fs.writeFileSync(file, "name: demo\nmode: review\nsteps:\n  - \"first\"\n  - second\n");
  const mission = loadMission(file);
  assert.equal(mission.name, "demo");
  assert.equal(mission.mode, "review");
  assert.deepEqual(mission.steps, ["first", "second"]);
});

test("loads json mission object steps", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "azy-mission-"));
  const file = path.join(dir, "mission.json");
  fs.writeFileSync(file, JSON.stringify({
    name: "objects",
    mode: "goal",
    continueOnError: true,
    steps: [{ agent: "implementer", prompt: "do it", maxSteps: 3 }]
  }));
  const mission = loadMission(file);
  assert.equal(mission.steps[0].agent, "implementer");
  assert.equal(mission.steps[0].maxSteps, 3);
});

test("missionPlan orders dependency steps", () => {
  const plan = missionPlan({
    steps: [
      { id: "implement", dependsOn: "plan", prompt: "implement" },
      { id: "plan", prompt: "plan" }
    ]
  }, { mode: "goal" });
  assert.deepEqual(plan.map((step) => step.id), ["plan", "implement"]);
  assert.match(formatMissionPlan({ steps: plan }, { mode: "goal" }), /dependsOn=plan/);
});

test("missionPlan rejects dependency cycles", () => {
  assert.throws(() => missionPlan({
    steps: [
      { id: "a", dependsOn: "b", prompt: "a" },
      { id: "b", dependsOn: "a", prompt: "b" }
    ]
  }, { mode: "goal" }), /cycle/);
});
