import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { id, loadState, saveState } from "./config.js";

export function loadMission(file) {
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  return parseTinyYaml(text);
}

export async function runMission({ cfg, cwd, file, confirmTool = null, onEvent = null }) {
  const mission = loadMission(file);
  const steps = missionPlan(mission, cfg);
  if (!mission.name) mission.name = path.basename(file);
  const missionId = id("mis");
  const state = loadState();
  state.missions[missionId] = {
    name: mission.name,
    file: path.resolve(file),
    status: "running",
    startedAt: new Date().toISOString(),
    steps: []
  };
  saveState(state);

  const outputs = [];
  for (const [index, normalized] of steps.entries()) {
    const subagent = normalized.agent ? cfg.subagents?.[normalized.agent] : null;
    let output;
    try {
      output = await runAgent({
        cfg,
        cwd,
        prompt: normalized.prompt,
        mode: normalized.mode,
        subagent,
        maxSteps: normalized.maxSteps,
        confirmTool,
        onEvent
      });
    } catch (error) {
      const latest = loadState();
      latest.missions[missionId].steps.push({ index: index + 1, prompt: normalized.prompt, status: "failed", error: error.message });
      if (!normalized.continueOnError) {
        latest.missions[missionId].status = "failed";
        latest.missions[missionId].finishedAt = new Date().toISOString();
        saveState(latest);
        throw error;
      }
      saveState(latest);
      outputs.push({ index: index + 1, prompt: normalized.prompt, output: `FAILED: ${error.message}`, failed: true });
      continue;
    }
    outputs.push({ index: index + 1, prompt: normalized.prompt, output });
    const latest = loadState();
    latest.missions[missionId].steps.push({ index: index + 1, prompt: normalized.prompt, status: "done" });
    saveState(latest);
  }

  const done = loadState();
  done.missions[missionId].status = "done";
  done.missions[missionId].finishedAt = new Date().toISOString();
  saveState(done);
  return { missionId, outputs };
}

export function missionPlan(mission, cfg = { mode: "plan" }) {
  if (!Array.isArray(mission.steps) || !mission.steps.length) {
    throw new Error("Mission file must contain a steps array.");
  }
  const normalized = mission.steps.map((step, index) => normalizeStep(step, mission, cfg, index));
  return orderSteps(normalized);
}

export function formatMissionPlan(mission, cfg) {
  const steps = missionPlan(mission, cfg);
  return steps.map((step, index) => {
    const depends = step.dependsOn.length ? ` dependsOn=${step.dependsOn.join(",")}` : "";
    const agent = step.agent ? ` agent=${step.agent}` : "";
    return `${index + 1}. ${step.id}${agent} mode=${step.mode} maxSteps=${step.maxSteps}${depends}\n   ${step.prompt}`;
  }).join("\n");
}

function normalizeStep(step, mission, cfg, index = 0) {
  if (typeof step === "string") {
    return {
      id: `step-${index + 1}`,
      prompt: step,
      agent: null,
      mode: mission.mode || cfg.mode,
      maxSteps: Number(mission.maxSteps) || 12,
      continueOnError: Boolean(mission.continueOnError),
      dependsOn: []
    };
  }
  if (!step?.prompt) throw new Error("Mission step object must include prompt.");
  return {
    id: step.id || `step-${index + 1}`,
    prompt: step.prompt,
    agent: step.agent || null,
    mode: step.mode || mission.mode || cfg.mode,
    maxSteps: Number(step.maxSteps || mission.maxSteps) || 12,
    continueOnError: Boolean(step.continueOnError ?? mission.continueOnError),
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : step.dependsOn ? [step.dependsOn] : []
  };
}

function orderSteps(steps) {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const ordered = [];
  const visiting = new Set();
  const visited = new Set();

  function visit(step) {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) throw new Error(`Mission dependency cycle at ${step.id}.`);
    visiting.add(step.id);
    for (const dep of step.dependsOn) {
      const parent = byId.get(dep);
      if (!parent) throw new Error(`Mission step ${step.id} depends on unknown step ${dep}.`);
      visit(parent);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    ordered.push(step);
  }

  for (const step of steps) visit(step);
  return ordered;
}

function parseTinyYaml(text) {
  const result = {};
  let currentList = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue) {
      const [, key, value] = keyValue;
      if (value === "") {
        result[key] = [];
        currentList = key;
      } else {
        result[key] = unquote(value);
        currentList = null;
      }
      continue;
    }
    const item = line.match(/^\s*-\s*(.*)$/);
    if (item && currentList) {
      result[currentList].push(unquote(item[1]));
    }
  }
  return result;
}

function unquote(value) {
  return String(value).replace(/^["']|["']$/g, "");
}
