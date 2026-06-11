import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { AgentCancelledError } from "./agent-errors.js";
import { id, updateState } from "./config.js";

function initMissionRecord(missionId, mission, file) {
  updateState((state) => {
    state.missions[missionId] = {
      name: mission.name,
      file: path.resolve(file),
      status: "running",
      startedAt: new Date().toISOString(),
      steps: []
    };
    return state;
  });
}

function appendMissionSteps(missionId, steps) {
  if (!steps.length) return;
  updateState((state) => {
    const mission = state.missions[missionId];
    if (!mission) return state;
    mission.steps.push(...steps);
    return state;
  });
}

function setMissionStatus(missionId, status) {
  updateState((state) => {
    const mission = state.missions[missionId];
    if (!mission) return state;
    mission.status = status;
    mission.finishedAt = new Date().toISOString();
    return state;
  });
}

export function loadMission(file) {
  if (!file.endsWith(".json") && !file.endsWith(".yml") && !file.endsWith(".yaml")) {
    throw new Error("Mission file must be .json, .yml, or .yaml.");
  }
  const text = fs.readFileSync(file, "utf8");
  if (file.endsWith(".json")) return JSON.parse(text);
  return parseTinyYaml(text);
}

export async function runMission({
  cfg,
  cwd,
  file,
  confirmTool = null,
  onEvent = null,
  progressStyle = "tui",
  signal = null,
  skills = [],
  includeContext = false
} = {}) {
  const mission = loadMission(file);
  const steps = missionPlan(mission, cfg);
  if (!mission.name) mission.name = path.basename(file);
  const missionId = id("mis");
  initMissionRecord(missionId, mission, file);

  const outputs = [];
  let missionConversation = [];
  onEvent?.({ type: "mission_start", missionId, name: mission.name, steps: steps.length });

  try {
    for (const [index, normalized] of steps.entries()) {
      if (normalized.isParallelGroup) {
        const groupResult = await runParallelMissionGroup({
          normalized,
          index,
          missionId,
          cfg,
          cwd,
          missionConversation,
          confirmTool,
          onEvent,
          progressStyle,
          signal,
          skills,
          includeContext
        });
        if (groupResult.cancelled) throw groupResult.error;
        outputs.push(...groupResult.outputs);
        if (groupResult.conversationEntry) missionConversation.push(groupResult.conversationEntry);
        continue;
      }

      const result = await runSingleMissionStep({
        normalized,
        index,
        missionId,
        cfg,
        cwd,
        missionConversation,
        confirmTool,
        onEvent,
        progressStyle,
        signal,
        skills,
        includeContext
      });
      if (result.cancelled) throw result.error;
      outputs.push(result.outputEntry);
      if (result.conversationEntry) missionConversation.push(result.conversationEntry);
    }

    setMissionStatus(missionId, "done");
    onEvent?.({ type: "mission_end", missionId, status: "done", steps: outputs.length });
    return { missionId, outputs };
  } catch (error) {
    const cancelled = error instanceof AgentCancelledError || signal?.aborted;
    setMissionStatus(missionId, cancelled ? "cancelled" : "failed");
    onEvent?.({ type: "mission_end", missionId, status: cancelled ? "cancelled" : "failed" });
    throw error;
  }
}

async function runParallelMissionGroup({
  normalized,
  index,
  missionId,
  cfg,
  cwd,
  missionConversation,
  confirmTool,
  onEvent,
  progressStyle,
  signal,
  skills,
  includeContext
}) {
  onEvent?.({
    type: "mission_step_start",
    missionId,
    step: index + 1,
    id: normalized.id,
    parallel: normalized.parallel.length
  });

  const childResults = await Promise.all(normalized.parallel.map(async (child) => {
    onEvent?.({
      type: "mission_step_start",
      missionId,
      step: index + 1,
      id: child.id,
      parentId: normalized.id,
      agent: child.agent || null
    });
    try {
      const result = await runSingleMissionStep({
        normalized: child,
        index,
        missionId,
        cfg,
        cwd,
        missionConversation,
        confirmTool,
        onEvent,
        progressStyle,
        signal,
        skills,
        includeContext,
        parentId: normalized.id,
        recordState: false
      });
      onEvent?.({
        type: "mission_step_end",
        missionId,
        step: index + 1,
        id: child.id,
        parentId: normalized.id,
        ok: true,
        agent: child.agent || null
      });
      return result;
    } catch (error) {
      onEvent?.({
        type: "mission_step_end",
        missionId,
        step: index + 1,
        id: child.id,
        parentId: normalized.id,
        ok: false,
        error: error.message,
        agent: child.agent || null
      });
      if (!(normalized.continueOnError || child.continueOnError)) {
        return { cancelled: true, error };
      }
      return {
        outputEntry: {
          index: index + 1,
          id: child.id,
          prompt: child.prompt,
          output: `FAILED: ${error.message}`,
          failed: true,
          parallel: true,
          parentId: normalized.id
        }
      };
    }
  }));

  const cancelled = childResults.find((result) => result?.cancelled);
  if (cancelled) return cancelled;

  const outputEntries = childResults.map((result) => result.outputEntry).filter(Boolean);
  const childStepRecords = childResults.map((result) => result.stepRecord).filter(Boolean);
  const combinedOutput = outputEntries.map((entry) => `### ${entry.id}\n${entry.output}`).join("\n\n");
  appendMissionSteps(missionId, [
    ...childStepRecords,
    {
      index: index + 1,
      id: normalized.id,
      prompt: normalized.prompt,
      status: outputEntries.every((entry) => !entry.failed) ? "done" : "partial",
      mode: normalized.mode,
      parallel: outputEntries.map((entry) => ({ id: entry.id, status: entry.failed ? "failed" : "done" }))
    }
  ]);

  onEvent?.({
    type: "mission_step_end",
    missionId,
    step: index + 1,
    id: normalized.id,
    ok: outputEntries.every((entry) => !entry.failed),
    parallel: normalized.parallel.length
  });

  return {
    outputs: outputEntries,
    conversationEntry: {
      index: index + 1,
      id: normalized.id,
      output: combinedOutput.slice(0, 4000)
    }
  };
}

async function runSingleMissionStep({
  normalized,
  index,
  missionId,
  cfg,
  cwd,
  missionConversation,
  confirmTool,
  onEvent,
  progressStyle,
  signal,
  skills,
  includeContext,
  parentId = null,
  recordState = true
}) {
  const subagent = normalized.agent ? cfg.subagents?.[normalized.agent] : null;
  let stepMode = normalized.mode;
  const prompt = buildMissionPrompt(normalized, missionConversation);

  if (!parentId) {
    onEvent?.({
      type: "mission_step_start",
      missionId,
      step: index + 1,
      id: normalized.id,
      agent: normalized.agent || null
    });
  }

  try {
    const output = await runAgent({
      cfg,
      cwd,
      prompt,
      mode: normalized.mode,
      subagent,
      maxSteps: normalized.maxSteps,
      confirmTool,
      onEvent,
      progressStyle,
      signal,
      skills,
      includeContext,
      onModeChange: ({ mode }) => {
        stepMode = mode;
      }
    });

    const outputEntry = {
      index: index + 1,
      id: normalized.id,
      prompt: normalized.prompt,
      output,
      parallel: Boolean(parentId),
      parentId
    };

    const stepRecord = {
      index: index + 1,
      id: normalized.id,
      prompt: normalized.prompt,
      status: "done",
      mode: stepMode,
      parentId
    };
    if (recordState) appendMissionSteps(missionId, [stepRecord]);

    if (!parentId) {
      onEvent?.({
        type: "mission_step_end",
        missionId,
        step: index + 1,
        id: normalized.id,
        ok: true,
        agent: normalized.agent || null
      });
    }

    return {
      outputEntry,
      stepRecord,
      conversationEntry: parentId
        ? null
        : { index: index + 1, id: normalized.id, output: String(output).slice(0, 4000) }
    };
  } catch (error) {
    const cancelled = error instanceof AgentCancelledError || signal?.aborted;
    const stepRecord = {
      index: index + 1,
      id: normalized.id,
      prompt: normalized.prompt,
      status: cancelled ? "cancelled" : "failed",
      error: error.message,
      mode: stepMode,
      parentId
    };
    if (recordState) appendMissionSteps(missionId, [stepRecord]);

    if (cancelled || !normalized.continueOnError) {
      if (recordState) setMissionStatus(missionId, cancelled ? "cancelled" : "failed");
      if (!parentId) {
        onEvent?.({
          type: "mission_step_end",
          missionId,
          step: index + 1,
          id: normalized.id,
          ok: false,
          error: error.message,
          agent: normalized.agent || null
        });
      }
      return { cancelled: true, error };
    }

    if (!parentId) {
      onEvent?.({
        type: "mission_step_end",
        missionId,
        step: index + 1,
        id: normalized.id,
        ok: false,
        error: error.message,
        agent: normalized.agent || null
      });
    }

    return {
      outputEntry: {
        index: index + 1,
        id: normalized.id,
        prompt: normalized.prompt,
        output: `FAILED: ${error.message}`,
        failed: true,
        parallel: Boolean(parentId),
        parentId
      },
      stepRecord
    };
  }
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
  return steps.map((step, index) => formatPlanStep(step, index + 1)).join("\n");
}

function formatPlanStep(step, index) {
  const depends = step.dependsOn.length ? ` dependsOn=${step.dependsOn.join(",")}` : "";
  const limit = step.maxSteps ? ` maxSteps=${step.maxSteps}` : " maxSteps=unlimited";
  if (step.isParallelGroup) {
    const children = step.parallel.map((child, childIndex) => {
      const agent = child.agent ? ` agent=${child.agent}` : "";
      return `     ${childIndex + 1}. ${child.id}${agent} mode=${child.mode}${limit}\n        ${child.prompt}`;
    }).join("\n");
    return `${index}. ${step.id} parallel=${step.parallel.length} mode=${step.mode}${depends}\n${children}`;
  }
  const agent = step.agent ? ` agent=${step.agent}` : "";
  return `${index}. ${step.id}${agent} mode=${step.mode}${limit}${depends}\n   ${step.prompt}`;
}

function normalizeStep(step, mission, cfg, index = 0) {
  if (typeof step === "string") {
    return {
      id: `step-${index + 1}`,
      prompt: step,
      agent: null,
      mode: mission.mode || cfg.mode,
      maxSteps: resolveMissionMaxSteps(mission.maxSteps),
      continueOnError: Boolean(mission.continueOnError),
      passContext: Boolean(mission.passContext && index > 0),
      dependsOn: []
    };
  }
  if (Array.isArray(step?.parallel)) {
    if (!step.parallel.length) throw new Error(`Parallel group ${step.id || `step-${index + 1}`} must include steps.`);
    return {
      id: step.id || `parallel-${index + 1}`,
      isParallelGroup: true,
      parallel: step.parallel.map((child, childIndex) => {
        const normalized = normalizeStep(child, mission, cfg, childIndex);
        if (normalized.isParallelGroup) {
          throw new Error(`Nested parallel groups are not supported (${normalized.id}).`);
        }
        return normalized;
      }),
      prompt: step.prompt || `Parallel group (${step.parallel.length} steps)`,
      agent: null,
      mode: step.mode || mission.mode || cfg.mode,
      maxSteps: resolveMissionMaxSteps(step.maxSteps ?? mission.maxSteps),
      continueOnError: Boolean(step.continueOnError ?? mission.continueOnError),
      passContext: Boolean(step.passContext ?? mission.passContext ?? index > 0),
      dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : step.dependsOn ? [step.dependsOn] : []
    };
  }
  if (!step?.prompt) throw new Error("Mission step object must include prompt.");
  return {
    id: step.id || `step-${index + 1}`,
    prompt: step.prompt,
    agent: step.agent || null,
    mode: step.mode || mission.mode || cfg.mode,
    maxSteps: resolveMissionMaxSteps(step.maxSteps ?? mission.maxSteps),
    continueOnError: Boolean(step.continueOnError ?? mission.continueOnError),
    passContext: Boolean(step.passContext ?? mission.passContext ?? index > 0),
    dependsOn: Array.isArray(step.dependsOn) ? step.dependsOn : step.dependsOn ? [step.dependsOn] : []
  };
}

function resolveMissionMaxSteps(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
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

function buildMissionPrompt(normalized, missionConversation = []) {
  const deps = normalized.dependsOn || [];
  let prior = [];
  if (deps.length) {
    prior = missionConversation.filter((entry) => deps.includes(entry.id));
  } else if (normalized.passContext) {
    prior = missionConversation;
  }
  if (!prior.length) return normalized.prompt;
  const context = prior.map((entry) => {
    const label = entry.id ? `${entry.id} (step ${entry.index})` : `Step ${entry.index}`;
    return `${label}: ${entry.output}`;
  }).join("\n\n");
  return `${normalized.prompt}\n\nPrior mission step outputs:\n${context}`;
}

function parseTinyYaml(text) {
  const result = {};
  let currentList = null;
  let currentObject = null;
  let objectIndent = 0;
  let nestedList = null;
  let nestedObject = null;
  let nestedObjectIndent = 0;
  const lines = text.split(/\r?\n/);

  const flushNestedObject = () => {
    if (!nestedObject || !nestedList) return;
    nestedList.target.push(nestedObject);
    nestedObject = null;
    nestedObjectIndent = 0;
  };

  const flushObject = () => {
    flushNestedObject();
    if (!currentObject || !currentList) return;
    result[currentList].push(currentObject);
    currentObject = null;
    objectIndent = 0;
    nestedList = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;

    const nestedField = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nestedObject && nestedField && nestedField[1].length > nestedObjectIndent) {
      nestedObject[nestedField[2]] = coerceYamlValue(nestedField[3]);
      continue;
    }

    const objectField = line.match(/^(\s+)([A-Za-z0-9_-]+):\s*(.*)$/);
    if (currentObject && objectField && objectField[1].length > objectIndent) {
      const [, indent, key, value] = objectField;
      if (key === "dependsOn" && value.startsWith("[")) {
        try {
          currentObject.dependsOn = JSON.parse(value);
        } catch {
          currentObject.dependsOn = value.split(",").map((part) => unquote(part.trim())).filter(Boolean);
        }
      } else if (key === "parallel" && value === "") {
        currentObject.parallel = [];
        nestedList = { target: currentObject.parallel, indent: indent.length };
      } else {
        currentObject[key] = coerceYamlValue(value);
      }
      continue;
    }

    const item = line.match(/^(\s*)-\s*(.*)$/);
    if (item) {
      const [, indent, value] = item;
      const trimmed = value.trim();

      if (nestedList && indent.length > nestedList.indent) {
        flushNestedObject();
        if (!trimmed) {
          nestedObject = {};
          nestedObjectIndent = indent.length + 1;
          continue;
        }
        if (trimmed.startsWith("{")) {
          nestedList.target.push(JSON.parse(trimmed));
          continue;
        }
        nestedList.target.push(coerceYamlValue(trimmed));
        continue;
      }

      flushObject();
      if (!currentList) {
        throw new Error(`Unexpected list item at line ${i + 1}: ${raw.trim()}`);
      }
      if (!trimmed) {
        currentObject = {};
        objectIndent = indent.length + 1;
        continue;
      }
      if (trimmed.startsWith("{")) {
        result[currentList].push(JSON.parse(trimmed));
        continue;
      }
      const inlineObject = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (inlineObject) {
        currentObject = { [inlineObject[1]]: coerceYamlValue(inlineObject[2]) };
        objectIndent = indent.length + 1;
        continue;
      }
      result[currentList].push(coerceYamlValue(trimmed));
      continue;
    }

    flushObject();

    const keyValue = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (keyValue && !line.startsWith(" ")) {
      const [, key, value] = keyValue;
      if (value === "") {
        result[key] = [];
        currentList = key;
      } else {
        result[key] = coerceYamlValue(value);
        currentList = null;
      }
    }
  }

  flushObject();
  return result;
}

function coerceYamlValue(value) {
  const trimmed = unquote(String(value).trim());
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function unquote(value) {
  return String(value).replace(/^["']|["']$/g, "");
}