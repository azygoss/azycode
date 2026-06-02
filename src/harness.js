import { loadState } from "./config.js";
import { gitGuard } from "./guard.js";
import { prettyMs, updateSpinnerLabel } from "./ui.js";

export function hasActiveProvider(cfg) {
  const name = cfg?.activeProvider;
  if (!name) return false;
  const provider = cfg.providers?.[name];
  return Boolean(provider?.apiKey || provider?.baseUrl);
}

export function runtimeSnapshot(cfg, cwd = process.cwd(), extras = {}) {
  const state = loadState();
  const guard = gitGuard(cwd, cfg);
  const policy = cfg.toolPolicy || {};
  const counts = Object.values(policy).reduce(
    (acc, value) => {
      if (value === "auto") acc.auto += 1;
      else if (value === "ask") acc.ask += 1;
      else if (value === "deny") acc.deny += 1;
      return acc;
    },
    { auto: 0, ask: 0, deny: 0 }
  );
  return {
    mode: extras.mode || cfg.mode,
    reasoning: cfg.reasoning,
    profile: cfg.permissionProfile || "normal",
    provider: cfg.activeProvider || null,
    model: cfg.activeModel || null,
    providerReady: hasActiveProvider(cfg),
    alwaysApprove: Boolean(cfg.alwaysApprove || cfg.mode === "always-approve"),
    guard,
    policy: counts,
    counts: {
      sessions: Object.keys(state.sessions || {}).length,
      goals: Object.keys(state.goals || {}).length,
      missions: Object.keys(state.missions || {}).length,
      toolRuns: (state.toolRuns || []).length
    },
    ...extras
  };
}

export function summarizeToolArgs(tool, args = {}) {
  if (!args || typeof args !== "object") return "";
  if (tool === "todo") {
    const bits = [args.action].filter(Boolean);
    if (args.id) bits.push(args.id);
    else if (args.text) bits.push(String(args.text).slice(0, 48));
    return bits.join(" ");
  }
  if (tool === "set_mode" && args.mode) return String(args.mode);
  if (args.path) return String(args.path);
  if (args.file) return String(args.file);
  if (args.command) return String(args.command).slice(0, 72);
  if (args.branch) return String(args.branch).slice(0, 72);
  if (args.query) return String(args.query).slice(0, 72);
  if (Array.isArray(args.paths) && args.paths.length) return `${args.paths.length} paths`;
  if (args.pattern) return String(args.pattern).slice(0, 72);
  if (args.patch) return "patch";
  return "";
}

function stepLabel(step, maxSteps) {
  if (!step) return "";
  if (maxSteps) return `Step ${step}/${maxSteps}`;
  return `Step ${step}`;
}

export function formatAgentStepLine(event, { maxSteps = null, style = "tui" } = {}) {
  if (!event?.type) return "";
  const limit = event.maxSteps ?? maxSteps;
  const prefix = stepLabel(event.step, limit);
  const summary = event.summary ? ` ${event.summary}` : "";
  if (event.type === "agent_run_start") {
    const limit = event.maxSteps ? `max ${event.maxSteps} steps` : "unlimited steps";
    return style === "cli"
      ? `[${event.sessionId}] run start · ${limit} · mode ${event.mode}`
      : `▸ run start · ${limit} · mode ${event.mode}`;
  }
  if (event.type === "model_start") {
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: model (${event.mode || "?"}) ${event.model || ""}`
      : `  ${prefix}  model  ${event.mode || "?"}  ${event.model || ""}`;
  }
  if (event.type === "model_end") {
    const tools = event.tools?.length ? `: ${event.tools.join(", ")}` : "";
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: ${event.toolCalls} tool call(s)${tools}`
      : `  ${prefix}  tools (${event.toolCalls})${tools}`;
  }
  if (event.type === "tool_start") {
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: → ${event.tool}${summary}`
      : `  ${prefix}  → ${event.tool}${summary}`;
  }
  if (event.type === "tool_end") {
    const status = event.ok ? "ok" : "failed";
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: ← ${event.tool} ${status} ${event.durationMs}ms`
      : `  ${prefix}  ← ${event.tool}  ${status}  ${prettyMs(event.durationMs)}`;
  }
  if (event.type === "mode_change") {
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: mode -> ${event.mode}`
      : `  ${prefix}  mode → ${event.mode}`;
  }
  if (event.type === "final") {
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: final answer`
      : `  ${prefix}  final answer`;
  }
  if (event.type === "step_limit") {
    return style === "cli"
      ? `[${event.sessionId}] ${prefix}: step limit reached`
      : `  ${prefix}  step limit reached`;
  }
  return formatAgentEvent(event, { style });
}

export function formatAgentRunReport(events, { maxSteps = null } = {}) {
  return (events || [])
    .map((event) => formatAgentStepLine(event, { maxSteps }))
    .filter(Boolean)
    .join("\n");
}

export function formatAgentEvent(event, { style = "tui" } = {}) {
  if (!event?.type) return "";
  const summary = event.summary ? ` ${event.summary}` : "";
  if (style === "cli") {
    if (event.type === "agent_run_start") return `[${event.sessionId}] run start`;
    if (event.type === "step_limit") return `[${event.sessionId}] step limit`;
    if (event.type === "mode_change") return `[${event.sessionId}] step ${event.step}: mode -> ${event.mode}`;
    if (event.type === "model_start") return `[${event.sessionId}] step ${event.step}: model ${event.model || "(active)"}`;
    if (event.type === "model_end") return `[${event.sessionId}] step ${event.step}: ${event.toolCalls} tool call(s)`;
    if (event.type === "tool_start") return `[${event.sessionId}] step ${event.step}: tool ${event.tool}${summary}`;
    if (event.type === "tool_end") return `[${event.sessionId}] step ${event.step}: tool ${event.tool} ${event.ok ? "ok" : "failed"} ${event.durationMs}ms`;
    if (event.type === "final") return `[${event.sessionId}] final`;
    return "";
  }
  if (event.type === "agent_run_start") return "run start";
  if (event.type === "step_limit") return "step limit";
  if (event.type === "mode_change") return `mode -> ${event.mode}`;
  if (event.type === "model_start") return `model step ${event.step}`;
  if (event.type === "tool_start") return `tool ${event.tool}${summary}`;
  if (event.type === "tool_end") return `${event.tool} ${event.ok ? "ok" : "failed"} ${prettyMs(event.durationMs)}`;
  if (event.type === "final") return "final answer";
  return "";
}

export function createAgentProgress({ spinner = null, maxSteps = null, style = "tui", onLine = null } = {}) {
  const write = onLine || ((line) => console.log(line));
  return (event) => {
    const line = formatAgentStepLine(event, { maxSteps, style });
    if (!line) return;
    if (spinner?.tty) spinner.stream.write(`\r${" ".repeat(80)}\r`);
    write(line, event);
    if (spinner) {
      const short = formatAgentEvent(event, { style });
      if (short) updateSpinnerLabel(short);
    }
  };
}