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
  if (args.path) return String(args.path);
  if (args.command) return String(args.command).slice(0, 72);
  if (args.query) return String(args.query).slice(0, 72);
  if (Array.isArray(args.paths) && args.paths.length) return `${args.paths.length} paths`;
  if (args.pattern) return String(args.pattern).slice(0, 72);
  if (args.patch) return "patch";
  return "";
}

export function formatAgentEvent(event, { style = "tui" } = {}) {
  if (!event?.type) return "";
  const summary = event.summary ? ` ${event.summary}` : "";
  if (style === "cli") {
    if (event.type === "model_start") return `[${event.sessionId}] step ${event.step}: model ${event.model || "(active)"}`;
    if (event.type === "model_end") return `[${event.sessionId}] step ${event.step}: ${event.toolCalls} tool call(s)`;
    if (event.type === "tool_start") return `[${event.sessionId}] step ${event.step}: tool ${event.tool}${summary}`;
    if (event.type === "tool_end") return `[${event.sessionId}] step ${event.step}: tool ${event.tool} ${event.ok ? "ok" : "failed"} ${event.durationMs}ms`;
    if (event.type === "final") return `[${event.sessionId}] final`;
    return "";
  }
  if (event.type === "model_start") return `model step ${event.step}`;
  if (event.type === "tool_start") return `tool ${event.tool}${summary}`;
  if (event.type === "tool_end") return `${event.tool} ${event.ok ? "ok" : "failed"} ${prettyMs(event.durationMs)}`;
  if (event.type === "final") return "final answer";
  return "";
}

export function createAgentProgress({ spinner = null, log = true, style = "tui", onLine = null } = {}) {
  return (event) => {
    const text = formatAgentEvent(event, { style });
    if (!text) return;
    if (spinner) {
      if (event.type === "model_start" || event.type === "tool_start" || event.type === "tool_end") {
        updateSpinnerLabel(text);
      }
      return;
    }
    if (log && onLine) onLine(text, event);
  };
}