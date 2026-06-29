import test from "node:test";
import assert from "node:assert/strict";
import { positionalArgs } from "../src/cli.js";

test("goal start text excludes max-steps and skill flag values", () => {
  const text = positionalArgs(["ship harness", "--max-steps", "5", "--skill", "tdd"], ["max-steps", "skill"]).join(" ");
  assert.equal(text, "ship harness");
});

test("backlog add text excludes priority and area flag values", () => {
  const text = positionalArgs(["harden guard", "--priority", "high", "--area", "safety"], ["priority", "area", "goal", "goal-id"]).join(" ");
  assert.equal(text, "harden guard");
});