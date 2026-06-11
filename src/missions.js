import fs from "node:fs";
import path from "node:path";
import { runAgent } from "./agent.js";
import { AgentCancelledError } from "./agent-errors.js";
import { id, MODES, updateState } from "./config.js";
import { profileCategoryPolicy } from "./permissions.js";
import { defaultSubagents } from "./prompts.js";

export const MISSION_RISK_LEVELS = ["low", "medium", "high"];

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

export function validateMission(mission, cfg = { mode: "plan", subagents: defaultSubagents() }) {
  const errors = [];
  const warnings = [];
  if (!mission || typeof mission !== "object") {
    errors.push("Mission must be an object.");
    return { ok: false, errors, warnings };
  }
  if (!Array.isArray(mission.steps) || !mission.steps.length) {
    errors.push("Mission file must contain a non-empty steps array.");
    return { ok: false, errors, warnings };
  }
  if (mission.mode && !MODES.includes(mission.mode)) {
    errors.push(`Mission mode must be one of: ${MODES.join(", ")}.`);
  }
  const missionMaxStepsError = validateMaxStepsValue(mission.maxSteps, "Mission");
  if (missionMaxStepsError) errors.push(missionMaxStepsError);

  const knownAgents = new Set(Object.keys(cfg.subagents || defaultSubagents()));
  const ids = new Map();
  for (const entry of collectMissionStepEntries(mission.steps)) {
    const { path: stepPath, step, isGroup } = entry;
    if (isGroup) {
      if (!step.id) warnings.push(`${stepPath}: parallel group missing id; will use generated id.`);
      if (step.mode && !MODES.includes(step.mode)) {
        errors.push(`${stepPath}: mode must be one of: ${MODES.join(", ")}.`);
      }
      const groupMaxStepsError = validateMaxStepsValue(step.maxSteps, stepPath);
      if (groupMaxStepsError) errors.push(groupMaxStepsError);
      continue;
    }
    if (typeof step === "string") continue;
    if (!step?.prompt) {
      errors.push(`${stepPath}: step object must include prompt.`);
      continue;
    }
    const stepId = step.id || inferStepId(stepPath);
    if (ids.has(stepId)) errors.push(`${stepPath}: duplicate step id '${stepId}'.`);
    else ids.set(stepId, stepPath);
    if (step.mode && !MODES.includes(step.mode)) {
      errors.push(`${stepPath}: mode must be one of: ${MODES.join(", ")}.`);
    }
    if (step.agent && !knownAgents.has(step.agent)) {
      errors.push(`${stepPath}: unknown subagent '${step.agent}'.`);
    }
    const maxStepsError = validateMaxStepsValue(step.maxSteps, stepPath);
    if (maxStepsError) errors.push(maxStepsError);
    const dependsOn = normalizeDependsOn(step.dependsOn);
    for (const dep of dependsOn) {
      if (!ids.has(dep) && !missionStepIds(mission.steps).includes(dep)) {
        warnings.push(`${stepPath}: dependsOn '${dep}' is not defined before this step in source order.`);
      }
    }
  }

  try {
    planMissionSteps(mission, cfg);
  } catch (error) {
    errors.push(error.message);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function buildMissionDryRun(mission, cfg = { mode: "plan", subagents: defaultSubagents() }) {
  const validation = validateMission(mission, cfg);
  if (!validation.ok) {
    return {
      ok: false,
      name: mission?.name || "mission",
      mode: mission?.mode || cfg.mode || "plan",
      continueOnError: Boolean(mission?.continueOnError),
      passContext: Boolean(mission?.passContext),
      errors: validation.errors,
      warnings: validation.warnings,
      steps: []
    };
  }
  const ordered = missionPlan(mission, cfg);
  return {
    ok: true,
    name: mission.name || "mission",
    mode: mission.mode || cfg.mode || "plan",
    continueOnError: Boolean(mission.continueOnError),
    passContext: Boolean(mission.passContext),
    errors: [],
    warnings: validation.warnings,
    steps: ordered.map((step, index) => describeDryRunStep(step, index + 1, cfg))
  };
}

export function missionPlan(mission, cfg = { mode: "plan" }) {
  const validation = validateMission(mission, cfg);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }
  return planMissionSteps(mission, cfg);
}

function planMissionSteps(mission, cfg = { mode: "plan" }) {
  if (!Array.isArray(mission.steps) || !mission.steps.length) {
    throw new Error("Mission file must contain a steps array.");
  }
  const normalized = mission.steps.map((step, index) => normalizeStep(step, mission, cfg, index));
  return orderSteps(normalized);
}

export function formatMissionPlan(mission, cfg) {
  const dryRun = buildMissionDryRun(mission, cfg);
  if (!dryRun.ok) throw new Error(dryRun.errors.join("\n"));
  const header = [
    `Mission: ${dryRun.name}`,
    `Mode: ${dryRun.mode}`,
    `Continue on error: ${dryRun.continueOnError ? "yes" : "no"}`,
    `Pass context: ${dryRun.passContext ? "yes" : "no"}`
  ];
  if (dryRun.warnings.length) {
    header.push("Warnings:");
    for (const warning of dryRun.warnings) header.push(`- ${warning}`);
  }
  const body = dryRun.steps.map((step) => formatDryRunStep(step)).join("\n");
  return `${header.join("\n")}\n\n${body}`;
}

function formatDryRunStep(step) {
  const depends = step.dependsOn?.length ? ` dependsOn=${step.dependsOn.join(",")}` : "";
  const limit = step.maxSteps ? ` maxSteps=${step.maxSteps}` : " maxSteps=unlimited";
  const context = step.passContext ? " passContext=yes" : "";
  const risk = ` risk=${step.risk}`;
  const permissions = ` permissions=read:${step.permissions.read},write:${step.permissions.write},shell:${step.permissions.shell},network:${step.permissions.network}`;
  if (step.parallel?.length) {
    const children = step.parallel.map((child, childIndex) => {
      const agent = child.agent ? ` agent=${child.agent}` : "";
      const childLimit = child.maxSteps ? ` maxSteps=${child.maxSteps}` : limit;
      return `     ${childIndex + 1}. ${child.id}${agent} mode=${child.mode}${childLimit}${risk}\n        ${child.prompt}`;
    }).join("\n");
    return `${step.index}. ${step.id} parallel=${step.parallel.length} mode=${step.mode}${depends}${context}${risk}${permissions}\n${children}`;
  }
  const agent = step.agent ? ` agent=${step.agent}` : "";
  return `${step.index}. ${step.id}${agent} mode=${step.mode}${limit}${depends}${context}${risk}${permissions}\n   ${step.prompt}`;
}

function describeDryRunStep(step, index, cfg) {
  const base = {
    index,
    id: step.id,
    mode: step.mode,
    agent: step.agent || null,
    maxSteps: step.maxSteps ?? null,
    dependsOn: step.dependsOn || [],
    passContext: Boolean(step.passContext),
    prompt: step.prompt,
    risk: missionStepRisk(step.mode),
    permissions: stepPermissions(cfg, step.mode)
  };
  if (step.isParallelGroup) {
    return {
      ...base,
      parallel: step.parallel.map((child) => ({
        id: child.id,
        mode: child.mode,
        agent: child.agent || null,
        maxSteps: child.maxSteps ?? null,
        prompt: child.prompt,
        risk: missionStepRisk(child.mode),
        permissions: stepPermissions(cfg, child.mode)
      }))
    };
  }
  return base;
}

function missionStepRisk(mode) {
  if (mode === "plan" || mode === "review") return "low";
  if (mode === "always-approve") return "high";
  return "medium";
}

function stepPermissions(cfg, mode) {
  const profile = cfg.permissionProfile || "normal";
  const alwaysApprove = mode === "always-approve" || Boolean(cfg.alwaysApprove);
  const categories = ["read", "write", "shell", "network", "git", "subagent"];
  const permissions = {};
  for (const category of categories) {
    let rule = profileCategoryPolicy(profile, category);
    if (alwaysApprove && rule !== "deny") rule = "auto";
    if ((mode === "plan" || mode === "review") && (category === "write" || category === "shell" || category === "network" || category === "subagent")) {
      rule = "deny";
    }
    permissions[category] = rule;
  }
  return permissions;
}

function validateMaxStepsValue(value, context) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return `${context}: maxSteps must be a positive number.`;
  }
  return null;
}

function normalizeDependsOn(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String);
  return [String(value)];
}

function inferStepId(stepPath) {
  const match = stepPath.match(/\[(\d+)\]/);
  return match ? `step-${Number(match[1]) + 1}` : "step";
}

function missionStepIds(steps) {
  const ids = [];
  steps.forEach((step, index) => {
    if (typeof step === "string") {
      ids.push(`step-${index + 1}`);
      return;
    }
    if (Array.isArray(step?.parallel)) {
      if (step.id) ids.push(step.id);
      for (const [childIndex, child] of step.parallel.entries()) {
        ids.push(child?.id || `step-${childIndex + 1}`);
      }
      return;
    }
    ids.push(step?.id || `step-${index + 1}`);
  });
  return ids;
}

function collectMissionStepEntries(steps, parentPath = "steps") {
  const entries = [];
  steps.forEach((step, index) => {
    const stepPath = `${parentPath}[${index}]`;
    if (typeof step === "string") {
      entries.push({ path: stepPath, step: { prompt: step } });
      return;
    }
    if (Array.isArray(step?.parallel)) {
      entries.push({ path: stepPath, step, isGroup: true });
      step.parallel.forEach((child, childIndex) => {
        entries.push({ path: `${stepPath}.parallel[${childIndex}]`, step: child });
      });
      return;
    }
    entries.push({ path: stepPath, step });
  });
  return entries;
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