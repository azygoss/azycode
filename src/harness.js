import { loadState, resolveAgentMaxSteps } from "./config.js";
import { formatGuard, gitGuard } from "./guard.js";
import { providerConfig } from "./providers.js";
import {
  accent,
  bold,
  brand,
  chip,
  diffBlock,
  error as errorText,
  faint,
  fileChangeBadge,
  icon,
  info as infoText,
  grokActionRow,
  grokPreviewLines,
  grokTimeLabel,
  miniPanel,
  muted,
  prettyMs,
  spinnerRunLabel,
  style,
  success as successText,
  timelineRow,
  updateSpinnerLabel,
  warn as warnText,
  toolCard,
  thinkingBlock,
  liveMetricsBar,
  costDisplay,
  estimateCost,
  toastMessage,
  richDiffBlock,
  breadcrumb
} from "./ui.js";

export const AGENT_EVENT_TYPES = [
  "agent_run_start",
  "agent_run_end",
  "model_start",
  "model_end",
  "tool_start",
  "tool_end",
  "approval_requested",
  "approval_granted",
  "approval_denied",
  "mode_change",
  "final",
  "step_limit",
  "step_budget_low",
  "context_trim",
  "context_compact",
  "subagent_start",
  "subagent_end",
  "subagent_supervisor",
  "mission_start",
  "mission_step_start",
  "mission_step_end",
  "mission_end",
  "agent_error",
  "model_token"
];

export const READ_ONLY_TOOLS = new Set([
  "list_files",
  "read_file",
  "read_many_files",
  "file_info",
  "search",
  "git_diff",
  "git_status",
  "git_log",
  "git_show",
  "web_fetch"
]);

const SUMMARY_LIMIT = 72;

export function isKnownAgentEvent(event) {
  return Boolean(event?.type && AGENT_EVENT_TYPES.includes(event.type));
}

export function hasActiveProvider(cfg) {
  const name = cfg?.activeProvider;
  if (!name) return false;
  try {
    const provider = providerConfig(cfg, name);
    return Boolean(String(provider.apiKey || "").trim());
  } catch {
    return false;
  }
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
    cwd,
    mode: extras.mode || cfg.mode,
    reasoning: cfg.reasoning,
    profile: cfg.permissionProfile || "normal",
    provider: cfg.activeProvider || null,
    model: cfg.activeModel || null,
    providerReady: hasActiveProvider(cfg),
    alwaysApprove: Boolean(cfg.alwaysApprove || cfg.mode === "always-approve"),
    agentMaxSteps: resolveAgentMaxSteps(cfg),
    guard,
    gitGuardEnabled: cfg.gitGuard?.enabled !== false,
    policy: counts,
    counts: {
      sessions: Object.keys(state.sessions || {}).length,
      goals: Object.keys(state.goals || {}).length,
      missions: Object.keys(state.missions || {}).length,
      toolRuns: (state.toolRuns || []).length,
      skills: Object.keys(cfg.skills || {}).length,
      subagents: Object.keys(cfg.subagents || {}).length
    },
    ...extras
  };
}

function clip(value, limit = SUMMARY_LIMIT) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

export function summarizeToolArgs(tool, args = {}) {
  if (!args || typeof args !== "object") return "";
  const name = String(tool || "");

  if (args.raw) return clip(String(args.raw), 40);

  if (name === "todo") {
    const bits = [args.action].filter(Boolean);
    if (args.id) bits.push(args.id);
    else if (args.text) bits.push(clip(args.text, 48));
    if (args.status) bits.push(args.status);
    return bits.join(" ");
  }

  if (name === "set_mode") {
    const bits = [args.mode].filter(Boolean);
    if (args.reason) bits.push(clip(args.reason, 40));
    return bits.join(" · ");
  }

  if (name === "read_file") {
    if (!args.file) return "";
    const file = String(args.file);
    if (args.startLine || args.endLine) {
      const start = args.startLine || 1;
      const end = args.endLine || start;
      return `${file}:${start}-${end}`;
    }
    return file;
  }

  if (name === "read_many_files" && Array.isArray(args.files) && args.files.length) {
    return args.files.length === 1 ? String(args.files[0]) : `${args.files.length} files`;
  }

  if (name === "list_files") {
    const bits = [args.dir || "."];
    if (args.depth != null) bits.push(`depth=${args.depth}`);
    return bits.join(" ");
  }

  if (name === "search") {
    const bits = [clip(args.query)];
    if (args.dir && args.dir !== ".") bits.push(`in ${args.dir}`);
    return bits.filter(Boolean).join(" ");
  }

  if ((name === "copy_path" || name === "move_path") && args.from && args.to) {
    return `${args.from} → ${args.to}`;
  }

  if (name === "edit_file" && args.file) {
    const bits = [String(args.file)];
    if (args.search) bits.push(clip(args.search, 24));
    return bits.join(" · ");
  }

  if (name === "apply_patch") {
    if (args.checkOnly) return "check";
    if (args.patch) return `patch (${clip(String(args.patch).split("\n")[0], 40)})`;
    return "patch";
  }

  if (name === "git_diff") return args.staged ? "staged" : "unstaged";
  if (name === "git_log" && args.limit != null) return `limit=${args.limit}`;
  if (name === "git_show") {
    if (args.file) return `${args.rev}:${args.file}`;
    return args.rev ? String(args.rev) : "";
  }
  if (name === "git_checkout" && args.branch) {
    return args.create ? `${args.branch} (create)` : String(args.branch);
  }
  if (name === "git_commit" && args.message) {
    const bits = [clip(args.message, 40)];
    if (args.all) bits.push("all");
    else if (Array.isArray(args.paths) && args.paths.length) bits.push(`${args.paths.length} paths`);
    return bits.join(" · ");
  }
  if (name === "web_fetch" && args.url) return clip(String(args.url), 56);
  if (name === "spawn_subagents" && Array.isArray(args.tasks) && args.tasks.length) {
    const agents = args.tasks.map((task) => task?.agent).filter(Boolean);
    return agents.length ? `${args.tasks.length} tasks · ${agents.join(", ")}` : `${args.tasks.length} tasks`;
  }
  if (name === "git_worktree") {
    const bits = [args.action].filter(Boolean);
    if (args.name) bits.push(String(args.name));
    if (args.branch) bits.push(String(args.branch));
    return bits.join(" ");
  }
  if (name === "git_status") return "status";
  if (name === "make_dir" && args.dir) return String(args.dir);
  if (name === "delete_path" && args.path) {
    return args.recursive ? `${args.path} (recursive)` : String(args.path);
  }

  if (args.file) return String(args.file);
  if (args.path) return String(args.path);
  if (args.command) return clip(args.command);
  if (args.branch) return clip(args.branch);
  if (args.query) return clip(args.query);
  if (args.pattern) return clip(args.pattern);
  if (Array.isArray(args.paths) && args.paths.length) return `${args.paths.length} paths`;
  if (args.patch) return "patch";
  return "";
}

function pickDiffPreviewLines(text, maxLines = 5) {
  return String(text ?? "")
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line))
    .slice(0, maxLines);
}

function diffStats(text) {
  const lines = String(text ?? "").split("\n");
  return {
    added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length
  };
}

export function extractToolPreview(tool, args = {}, content = "", { maxLines = 5 } = {}) {
  const name = String(tool || "");
  const text = String(content ?? "").trim();
  if (!text) return null;

  if (name === "write_file" && args.file) {
    const lineCount = text.split("\n").length;
    return { kind: "file", file: String(args.file), added: lineCount, removed: 0, action: "wrote" };
  }

  if (name === "edit_file" && args.file) {
    const added = args.replace ? String(args.replace).split("\n").length : 1;
    const removed = args.search ? String(args.search).split("\n").length : 1;
    return { kind: "file", file: String(args.file), added, removed, action: "edited" };
  }

  if (name === "delete_path" && args.path) {
    return { kind: "file", file: String(args.path), added: 0, removed: 1, action: "deleted" };
  }

  if (name === "copy_path" && args.to) {
    return { kind: "file", file: String(args.to), added: 1, removed: 0, action: "copied" };
  }

  if (name === "move_path" && args.from && args.to) {
    return { kind: "file", file: `${args.from} → ${args.to}`, action: "moved" };
  }

  if (name === "apply_patch" || name === "git_diff") {
    const stats = diffStats(text);
    const lines = pickDiffPreviewLines(text, maxLines);
    if (!lines.length && name === "git_diff") {
      const summary = text.split("\n").find((line) => /files? changed|insertions?|deletions?/i.test(line));
      if (summary) return { kind: "output", lines: [summary.trim()] };
    }
    return { kind: "diff", lines, added: stats.added, removed: stats.removed };
  }

  if (name === "shell") {
    const lines = pickDiffPreviewLines(text, maxLines);
    if (lines.length) {
      const stats = diffStats(text);
      return { kind: "diff", lines, added: stats.added, removed: stats.removed };
    }
    const outputLines = text.split("\n").map((line) => line.trimEnd()).filter(Boolean);
    if (outputLines.length) return { kind: "output", lines: outputLines.slice(0, maxLines) };
  }

  if (name === "git_commit") {
    const first = text.split("\n").find((line) => line.trim()) || text;
    return { kind: "output", lines: [clip(first, 72)] };
  }

  return null;
}

export function formatToolPreviewLines(preview, { width = 80, indent = 4, boxed = true, style = "rich" } = {}) {
  if (!preview) return [];
  const pad = " ".repeat(indent);
  const innerWidth = Math.min(68, Math.max(28, width - indent - 4));
  let body = [];
  if (preview.kind === "diff") {
    if (preview.added || preview.removed) body.push(fileChangeBadge({ added: preview.added, removed: preview.removed }));
    body.push(...diffBlock((preview.lines || []).join("\n"), {
      maxLines: preview.lines?.length || 5,
      indent: 0,
      width: innerWidth,
      gutter: true
    }));
  } else if (preview.kind === "file") {
    body.push(fileChangeBadge(preview));
  } else if (preview.kind === "output") {
    body = (preview.lines || []).map((line) => faint(clip(String(line), Math.max(16, innerWidth - 2))));
  }
  if (!body.length) return [];
  if (!boxed || style === "grok") return grokPreviewLines(body, { indent });
  const framed = miniPanel(body, { width: innerWidth, title: preview.kind === "diff" ? "diff" : "preview" });
  return framed.map((line) => `${pad}${line}`);
}

export function formatAgentStepExtras(event, { style = "tui", width = 80 } = {}) {
  if (!["rich", "grok"].includes(style)) return [];
  if (event?.type !== "tool_end" || !event.ok || !event.preview) return [];
  return formatToolPreviewLines(event.preview, { width, indent: 4, boxed: style !== "grok", style });
}

function stepLabel(step, maxSteps) {
  if (!step) return "";
  if (maxSteps && step <= maxSteps) return `Step ${step}/${maxSteps}`;
  return `Step ${step}`;
}

function sessionPrefix(event, style) {
  if (!event?.sessionId) return "";
  return style === "cli" ? `[${event.sessionId}] ` : "";
}

function formatToolStatus(event) {
  if (event.code === "invalid_args") return "invalid args";
  if (event.code === "unknown_tool") return "unknown";
  if (event.code === "rejected") return "rejected";
  if (event.code === "timeout") return "timeout";
  if (event.code === "partial_error") return "partial error";
  return event.ok ? "ok" : "failed";
}

function formatStepBudget(event, limit) {
  const cap = event.maxSteps ?? limit;
  return cap ? `max ${cap} steps` : "unlimited steps";
}

function toolGlyph(tool = "") {
  const name = String(tool);
  if (name.includes("shell") || name === "exec") return { glyph: icon("terminal"), style: "accent" };
  if (name.includes("read") || name.includes("file") || name.includes("list")) return { glyph: icon("file"), style: "info" };
  if (name.includes("search") || name.includes("grep")) return { glyph: icon("search"), style: "info" };
  if (name.includes("write") || name.includes("edit") || name.includes("patch")) return { glyph: icon("edit"), style: "warn" };
  if (name.includes("git")) return { glyph: icon("git"), style: "accent" };
  if (name.includes("web") || name.includes("fetch")) return { glyph: icon("link"), style: "info" };
  if (name.includes("subagent") || name.includes("spawn")) return { glyph: icon("agent"), style: "brand" };
  if (name.includes("mission") || name.includes("todo")) return { glyph: icon("mission"), style: "brand" };
  return { glyph: icon("bullet"), style: "muted" };
}

function richStepPrefix(step, limit) {
  if (!step) return "";
  const label = limit && step <= limit ? `Step ${step}/${limit}` : `Step ${step}`;
  return style(label, "subtle");
}

function richToolStatus(event) {
  const status = formatToolStatus(event);
  if (status === "ok") return successText(status);
  if (status === "rejected" || status === "timeout" || status === "failed" || status === "partial error") return errorText(status);
  if (status === "invalid args" || status === "unknown") return warnText(status);
  return muted(status);
}

function grokToolVerb(tool = "") {
  const name = String(tool);
  if (name.includes("read")) return "Read";
  if (name.includes("write") || name.includes("edit") || name === "apply_patch") return "Edit";
  if (name.includes("search") || name === "grep") return "Search";
  if (name === "shell" || name === "exec") return "Shell";
  if (name.includes("list") || name === "glob") return "List";
  if (name.includes("web") || name.includes("fetch")) return "Fetch";
  if (name.includes("git_diff")) return "Diff";
  if (name.includes("git_commit")) return "Commit";
  if (name.includes("subagent") || name.includes("spawn")) return "Agent";
  if (name.includes("mission")) return "Mission";
  return name.replace(/_/g, " ");
}

function formatAgentStepLineGrok(event, { maxSteps = null, width = null } = {}) {
  if (!event?.type) return "";
  const ts = grokTimeLabel();
  const cols = width || process.stdout.columns || 80;

  if (event.type === "model_end" && event.durationMs != null) {
    if (typeof thinkingBlock === "function") {
      const lines = thinkingBlock({
        duration: prettyMs(event.durationMs),
        tokens: event.usage?.total_tokens || null,
        model: event.model || null,
        width: cols
      });
      return lines.join("\n");
    }
    return grokActionRow(`Thought for ${prettyMs(event.durationMs)}`, "", { timestamp: ts, width: cols });
  }
  if (event.type === "tool_end") {
    if (typeof toolCard === "function") {
      const verb = grokToolVerb(event.tool);
      const lines = toolCard({
        tool: verb,
        status: event.ok ? "ok" : (formatToolStatus(event) || "failed"),
        duration: event.durationMs != null ? prettyMs(event.durationMs) : null,
        summary: event.summary || "",
        preview: event.preview || null,
        step: event.step,
        maxSteps,
        width: cols
      });
      return lines.join("\n");
    }
    const verb = grokToolVerb(event.tool);
    const detail = event.summary || "";
    const status = formatToolStatus(event);
    const meta = event.ok ? prettyMs(event.durationMs) : status;
    return grokActionRow(verb, detail, {
      meta: event.ok ? muted(meta) : errorText(meta),
      timestamp: ts,
      width: cols
    });
  }
  if (event.type === "mode_change") {
    return grokActionRow("Mode", event.mode || "", { meta: event.reason ? muted(clip(event.reason, 48)) : null, timestamp: ts, width: cols });
  }
  if (event.type === "subagent_start") {
    return grokActionRow("Agent", event.agent || "", { timestamp: ts, width: cols });
  }
  if (event.type === "agent_error") {
    return grokActionRow("Error", clip(event.error || event.message, 72), { timestamp: ts, width: cols });
  }
  return "";
}

function formatAgentStepLineRich(event, { maxSteps = null } = {}) {
  if (!event?.type) return "";
  const limit = event.maxSteps ?? maxSteps;
  const summary = event.summary ? ` ${muted(event.summary)}` : "";

  if (event.type === "agent_run_start") {
    const stepText = formatStepBudget(event, limit);
    const model = event.model ? ` ${infoText(event.model)}` : "";
    return timelineRow({
      glyph: icon("chevronRight"),
      glyphStyle: "brand",
      label: `${bold("run")} ${muted(stepText)} ${chip(event.mode || "agent", "info")}${model}`
    });
  }
  if (event.type === "agent_run_end") {
    const status = event.status || "done";
    const duration = event.durationMs != null ? faint(` · ${prettyMs(event.durationMs)}`) : "";
    const statusStyle = status === "ok" ? "success" : status === "error" ? "error" : "warn";
    return timelineRow({
      glyph: icon("chevronRight"),
      glyphStyle: statusStyle,
      label: `${bold("run")} ${style(status, statusStyle)}${duration}`,
      status: status === "ok"
    });
  }
  if (event.type === "model_start") {
    return timelineRow({
      glyph: icon("stream"),
      glyphStyle: "info",
      label: `${richStepPrefix(event.step, limit)}  ${muted("thinking")}`,
      detail: `${infoText(event.mode || "?")} ${faint(event.model || "")}`,
      indent: 1
    });
  }
  if (event.type === "model_end") {
    const tools = event.tools?.length ? faint(` · ${event.tools.join(", ")}`) : "";
    const timing = event.durationMs != null ? faint(` · ${prettyMs(event.durationMs)}`) : "";
    const usage = event.usage?.total_tokens ? faint(` · ${event.usage.total_tokens} tok`) : "";
    return timelineRow({
      glyph: icon("stream"),
      glyphStyle: "brand",
      label: `${richStepPrefix(event.step, limit)}  ${accent(`${event.toolCalls} tool call${event.toolCalls === 1 ? "" : "s"}`)}${tools}${timing}${usage}`,
      indent: 1
    });
  }
  if (event.type === "tool_start") {
    const glyph = toolGlyph(event.tool);
    return timelineRow({
      glyph: glyph.glyph,
      glyphStyle: "faint",
      branch: "mid",
      label: `${richStepPrefix(event.step, limit)}  ${muted(event.tool)}${summary ? muted(summary) : ""}  ${faint("…")}`,
      indent: 1
    });
  }
  if (event.type === "tool_end") {
    const glyph = toolGlyph(event.tool);
    const statusLabel = formatToolStatus(event);
    const detail = !event.ok && event.errorPreview ? ` ${errorText(clip(event.errorPreview, 48))}` : summary;
    return timelineRow({
      glyph: glyph.glyph,
      glyphStyle: event.ok ? "success" : "error",
      branch: event.preview ? "mid" : "last",
      label: `${richStepPrefix(event.step, limit)}  ${bold(accent(event.tool))}  ${chip(statusLabel, event.ok ? "success" : "error")}  ${faint(prettyMs(event.durationMs))}${detail}`,
      indent: 1,
      status: event.ok
    });
  }
  if (event.type === "mode_change") {
    const reason = event.reason ? faint(` · ${clip(event.reason, 40)}`) : "";
    return timelineRow({
      glyph: icon("chevron"),
      glyphStyle: "warn",
      label: `${richStepPrefix(event.step, limit)}  ${warnText("mode")} ${chip(event.mode, "info")}${reason}`,
      indent: 1
    });
  }
  if (event.type === "final") {
    return timelineRow({
      glyph: icon("sparkle"),
      glyphStyle: "brand",
      branch: "last",
      label: `${richStepPrefix(event.step, limit)}  ${bold(successText("answer ready"))}`,
      indent: 1,
      status: true
    });
  }
  if (event.type === "step_limit") {
    const at = event.stoppedAtStep ?? event.step;
    const label = at ? ` at step ${at}` : "";
    return timelineRow({
      glyph: icon("warn"),
      glyphStyle: "warn",
      label: `${richStepPrefix(event.step, limit)}  ${warnText(`step limit${label}`)}`,
      indent: 1
    });
  }
  if (event.type === "step_budget_low") {
    const remaining = event.remaining != null ? faint(` (${event.remaining} left)`) : "";
    return timelineRow({
      glyph: icon("warn"),
      glyphStyle: "warn",
      label: `${richStepPrefix(event.step, limit)}  ${warnText("step budget low")}${remaining}`,
      indent: 1
    });
  }
  if (event.type === "approval_requested") {
    return timelineRow({
      glyph: icon("warn"),
      glyphStyle: "warn",
      label: `${richStepPrefix(event.step, limit)}  ${warnText("approve?")} ${accent(event.tool)}${summary}`,
      indent: 1
    });
  }
  if (event.type === "approval_granted") {
    return timelineRow({
      glyph: icon("check"),
      glyphStyle: "success",
      label: `${richStepPrefix(event.step, limit)}  ${successText(`approved ${event.tool}`)}`,
      indent: 1,
      status: true
    });
  }
  if (event.type === "approval_denied") {
    return timelineRow({
      glyph: icon("cross"),
      glyphStyle: "error",
      label: `${richStepPrefix(event.step, limit)}  ${errorText(`denied ${event.tool}`)}`,
      indent: 1
    });
  }
  if (event.type === "context_trim") {
    const delta = event.before != null && event.after != null ? faint(` ${event.before}→${event.after}`) : "";
    return timelineRow({
      glyph: icon("bullet"),
      glyphStyle: "muted",
      label: `${richStepPrefix(event.step, limit)}  ${muted("context trimmed")}${delta}`,
      indent: 1
    });
  }
  if (event.type === "context_compact") {
    const delta = event.before != null && event.after != null ? faint(` ${event.before}→${event.after}`) : "";
    const method = event.method ? faint(` (${event.method})`) : "";
    return timelineRow({
      glyph: icon("bullet"),
      glyphStyle: "muted",
      label: `${richStepPrefix(event.step, limit)}  ${muted("context compacted")}${method}${delta}`,
      indent: 1
    });
  }
  if (event.type === "subagent_start") {
    const label = event.agent ? brand(`@${event.agent}`) : muted("subagent");
    return timelineRow({
      glyph: icon("agent"),
      glyphStyle: "brand",
      label: `${richStepPrefix(event.step, limit)}  ${label} ${muted("started")}`,
      indent: 1
    });
  }
  if (event.type === "subagent_end") {
    const timing = event.durationMs != null ? faint(` · ${prettyMs(event.durationMs)}`) : "";
    return timelineRow({
      glyph: icon("agent"),
      glyphStyle: event.ok ? "success" : "error",
      label: `${richStepPrefix(event.step, limit)}  ${brand(`@${event.agent || "?"}`)} ${event.ok ? successText("done") : errorText("failed")}${timing}`,
      indent: 1,
      status: event.ok
    });
  }
  if (event.type === "mission_start") {
    return timelineRow({
      glyph: icon("mission"),
      glyphStyle: "info",
      label: `${bold("mission")} ${infoText(event.name || event.missionId)} ${muted(`· ${event.steps || "?"} steps`)}`
    });
  }
  if (event.type === "mission_step_start") {
    const parallel = event.parallel ? faint(` · ${event.parallel} parallel`) : "";
    const agent = event.agent ? ` ${brand(`@${event.agent}`)}` : "";
    return timelineRow({
      glyph: icon("mission"),
      glyphStyle: "info",
      label: `${muted(`mission ${event.step}`)}  ${accent(event.id || "?")} ${muted("start")}${parallel}${agent}`,
      indent: 1
    });
  }
  if (event.type === "mission_step_end") {
    const parallel = event.parallel ? faint(` · ${event.parallel} parallel`) : "";
    return timelineRow({
      glyph: icon("mission"),
      glyphStyle: event.ok ? "success" : "error",
      label: `${muted(`mission ${event.step}`)}  ${accent(event.id || "?")} ${event.ok ? successText("ok") : errorText("failed")}${parallel}`,
      indent: 1,
      status: event.ok
    });
  }
  if (event.type === "mission_end") {
    const status = event.status || "done";
    return timelineRow({
      glyph: icon("mission"),
      glyphStyle: status === "ok" ? "success" : "warn",
      label: `${bold("mission")} ${style(status, status === "ok" ? "success" : "warn")}`,
      status: status === "ok"
    });
  }
  if (event.type === "agent_error") {
    return timelineRow({
      glyph: icon("cross"),
      glyphStyle: "error",
      label: `${richStepPrefix(event.step, limit)}  ${errorText(clip(event.error || event.message, 60))}`,
      indent: 1
    });
  }
  return formatAgentStepLine(event, { maxSteps: limit, style: "tui" });
}

export function formatAgentStepLine(event, { maxSteps = null, style = "tui", width = null } = {}) {
  if (style === "grok") return formatAgentStepLineGrok(event, { maxSteps, width });
  if (style === "rich") return formatAgentStepLineRich(event, { maxSteps });
  if (!event?.type) return "";
  const limit = event.maxSteps ?? maxSteps;
  const prefix = stepLabel(event.step, limit);
  const summary = event.summary ? ` ${event.summary}` : "";
  const sid = sessionPrefix(event, style);

  if (event.type === "agent_run_start") {
    const stepText = formatStepBudget(event, limit);
    const model = event.model ? ` · ${event.model}` : "";
    return style === "cli"
      ? `${sid}run start · ${stepText} · mode ${event.mode}${model}`
      : `▸ run start · ${stepText} · mode ${event.mode}${model}`;
  }
  if (event.type === "agent_run_end") {
    const status = event.status || "done";
    const duration = event.durationMs != null ? ` · ${style === "cli" ? `${event.durationMs}ms` : prettyMs(event.durationMs)}` : "";
    return style === "cli"
      ? `${sid}run end · ${status}${duration}`
      : `▸ run end · ${status}${duration}`;
  }
  if (event.type === "model_start") {
    return style === "cli"
      ? `${sid}${prefix}: model (${event.mode || "?"}) ${event.model || ""}`
      : `  ${prefix}  model  ${event.mode || "?"}  ${event.model || ""}`;
  }
  if (event.type === "model_end") {
    const tools = event.tools?.length ? `: ${event.tools.join(", ")}` : "";
    const timing = event.durationMs != null
      ? ` · ${style === "cli" ? `${event.durationMs}ms` : prettyMs(event.durationMs)}`
      : "";
    const usage = event.usage?.total_tokens ? ` · ${event.usage.total_tokens} tok` : "";
    return style === "cli"
      ? `${sid}${prefix}: ${event.toolCalls} tool call(s)${tools}${timing}${usage}`
      : `  ${prefix}  tools (${event.toolCalls})${tools}${timing}${usage}`;
  }
  if (event.type === "tool_start") {
    return style === "cli"
      ? `${sid}${prefix}: > ${event.tool}${summary}`
      : `  ${prefix}  → ${event.tool}${summary}`;
  }
  if (event.type === "tool_end") {
    const status = formatToolStatus(event);
    const detail = !event.ok && event.errorPreview ? ` · ${clip(event.errorPreview, 48)}` : summary;
    return style === "cli"
      ? `${sid}${prefix}: < ${event.tool} ${status} ${event.durationMs}ms${detail}`
      : `  ${prefix}  ← ${event.tool}  ${status}  ${prettyMs(event.durationMs)}${detail}`;
  }
  if (event.type === "mode_change") {
    const reason = event.reason ? ` (${clip(event.reason, 40)})` : "";
    return style === "cli"
      ? `${sid}${prefix}: mode -> ${event.mode}${reason}`
      : `  ${prefix}  mode → ${event.mode}${reason}`;
  }
  if (event.type === "final") {
    return style === "cli"
      ? `${sid}${prefix}: final answer`
      : `  ${prefix}  final answer`;
  }
  if (event.type === "step_limit") {
    const at = event.stoppedAtStep ?? event.step;
    const label = at ? ` at step ${at}` : "";
    return style === "cli"
      ? `${sid}${prefix}: step limit reached${label}`
      : `  ${prefix}  step limit reached${label}`;
  }
  if (event.type === "step_budget_low") {
    const remaining = event.remaining != null ? ` (${event.remaining} left)` : "";
    return style === "cli"
      ? `${sid}${prefix}: step budget low${remaining}`
      : `  ${prefix}  step budget low${remaining}`;
  }
  if (event.type === "approval_requested") {
    return style === "cli"
      ? `${sid}${prefix}: approve? ${event.tool}${summary}`
      : `  ${prefix}  approve? ${event.tool}${summary}`;
  }
  if (event.type === "approval_granted") {
    return style === "cli"
      ? `${sid}${prefix}: approved ${event.tool}`
      : `  ${prefix}  approved ${event.tool}`;
  }
  if (event.type === "approval_denied") {
    return style === "cli"
      ? `${sid}${prefix}: denied ${event.tool}`
      : `  ${prefix}  denied ${event.tool}`;
  }
  if (event.type === "context_trim") {
    const delta = event.before != null && event.after != null ? ` ${event.before}→${event.after}` : "";
    return style === "cli"
      ? `${sid}${prefix}: context trimmed${delta}`
      : `  ${prefix}  context trimmed${delta}`;
  }
  if (event.type === "context_compact") {
    const delta = event.before != null && event.after != null ? ` ${event.before}→${event.after}` : "";
    const method = event.method ? ` (${event.method})` : "";
    return style === "cli"
      ? `${sid}${prefix}: context compacted${method}${delta}`
      : `  ${prefix}  context compacted${method}${delta}`;
  }
  if (event.type === "subagent_start") {
    const label = event.agent ? ` ${event.agent}` : "";
    return style === "cli"
      ? `${sid}${prefix}: subagent start${label}`
      : `  ${prefix}  subagent start${label}`;
  }
  if (event.type === "subagent_end") {
    const status = event.ok ? "ok" : "failed";
    const timing = event.durationMs != null
      ? ` · ${style === "cli" ? `${event.durationMs}ms` : prettyMs(event.durationMs)}`
      : "";
    return style === "cli"
      ? `${sid}${prefix}: subagent end · ${event.agent || "?"} · ${status}${timing}`
      : `  ${prefix}  subagent end · ${event.agent || "?"} · ${status}${timing}`;
  }
  if (event.type === "mission_start") {
    return style === "cli"
      ? `${sid}mission start · ${event.name || event.missionId} · ${event.steps || "?"} steps`
      : `▸ mission start · ${event.name || event.missionId} · ${event.steps || "?"} steps`;
  }
  if (event.type === "mission_step_start") {
    const parallel = event.parallel ? ` · ${event.parallel} parallel` : "";
    const parent = event.parentId ? ` · parent ${event.parentId}` : "";
    const agent = event.agent ? ` · ${event.agent}` : "";
    return style === "cli"
      ? `${sid}mission step ${event.step}: ${event.id || "?"} start${parallel}${parent}${agent}`
      : `  mission ${event.step}  ${event.id || "?"} start${parallel}${parent}${agent}`;
  }
  if (event.type === "mission_step_end") {
    const status = event.ok ? "ok" : "failed";
    const parallel = event.parallel ? ` · ${event.parallel} parallel` : "";
    const parent = event.parentId ? ` · parent ${event.parentId}` : "";
    return style === "cli"
      ? `${sid}mission step ${event.step}: ${event.id || "?"} ${status}${parallel}${parent}`
      : `  mission ${event.step}  ${event.id || "?"} ${status}${parallel}${parent}`;
  }
  if (event.type === "mission_end") {
    return style === "cli"
      ? `${sid}mission end · ${event.status || "done"}`
      : `▸ mission end · ${event.status || "done"}`;
  }
  if (event.type === "agent_error") {
    return style === "cli"
      ? `${sid}${prefix}: error · ${clip(event.error || event.message, 60)}`
      : `  ${prefix}  error · ${clip(event.error || event.message, 60)}`;
  }
  return formatAgentEvent(event, { style }) || `  (${event.type})`;
}

export function formatAgentRunReport(events, { maxSteps = null, style = "tui" } = {}) {
  return (events || [])
    .map((event) => formatAgentStepLine(event, { maxSteps, style }))
    .filter(Boolean)
    .join("\n");
}

export function formatAgentEvent(event, { style = "tui" } = {}) {
  if (!event?.type) return "";
  const summary = event.summary ? ` ${event.summary}` : "";
  const sid = sessionPrefix(event, style);

  if (style === "cli") {
    if (event.type === "agent_run_start") return `${sid}run start`;
    if (event.type === "agent_run_end") return `${sid}run end · ${event.status || "done"}`;
    if (event.type === "step_limit") return `${sid}step limit`;
    if (event.type === "step_budget_low") return `${sid}step budget low`;
    if (event.type === "mode_change") return `${sid}step ${event.step}: mode -> ${event.mode}`;
    if (event.type === "model_start") return `${sid}step ${event.step}: model ${event.model || "(active)"}`;
    if (event.type === "model_end") {
      const tools = event.tools?.length ? `: ${event.tools.join(", ")}` : "";
      return `${sid}step ${event.step}: ${event.toolCalls} tool call(s)${tools}`;
    }
    if (event.type === "tool_start") return `${sid}step ${event.step}: tool ${event.tool}${summary}`;
    if (event.type === "tool_end") return `${sid}step ${event.step}: tool ${event.tool} ${formatToolStatus(event)} ${event.durationMs}ms`;
    if (event.type === "final") return `${sid}final`;
    if (event.type === "agent_error") return `${sid}error · ${clip(event.error || event.message, 40)}`;
    if (event.type === "approval_requested") return `${sid}approve? ${event.tool}`;
    if (event.type === "approval_granted") return `${sid}approved ${event.tool}`;
    if (event.type === "approval_denied") return `${sid}denied ${event.tool}`;
    if (event.type === "context_trim") return `${sid}context trimmed`;
    if (event.type === "context_compact") return `${sid}context compacted`;
    if (event.type === "subagent_start") return `${sid}subagent start · ${event.agent || "?"}`;
    if (event.type === "subagent_end") return `${sid}subagent end · ${event.agent || "?"} · ${event.ok ? "ok" : "failed"}`;
    if (event.type === "mission_start") return `${sid}mission start`;
    if (event.type === "mission_step_start") return `${sid}mission step ${event.id || "?"}`;
    if (event.type === "mission_step_end") return `${sid}mission step ${event.id || "?"} ${event.ok ? "ok" : "failed"}`;
    if (event.type === "mission_end") return `${sid}mission end · ${event.status || "done"}`;
    return "";
  }

  if (event.type === "agent_run_start") return "run start";
  if (event.type === "agent_run_end") return `run end · ${event.status || "done"}`;
  if (event.type === "step_limit") return "step limit";
  if (event.type === "step_budget_low") return "step budget low";
  if (event.type === "mode_change") return `mode -> ${event.mode}`;
  if (event.type === "model_start") return `model step ${event.step}`;
  if (event.type === "model_end") {
    const tools = event.tools?.length ? `: ${event.tools.join(", ")}` : "";
    return `tools (${event.toolCalls})${tools}`;
  }
  if (event.type === "tool_start") return `tool ${event.tool}${summary}`;
  if (event.type === "tool_end") return `${event.tool} ${formatToolStatus(event)} ${prettyMs(event.durationMs)}`;
  if (event.type === "final") return "final answer";
  if (event.type === "agent_error") return `error · ${clip(event.error || event.message, 40)}`;
  if (event.type === "approval_requested") return `approve? ${event.tool}`;
  if (event.type === "approval_granted") return `approved ${event.tool}`;
  if (event.type === "approval_denied") return `denied ${event.tool}`;
  if (event.type === "context_trim") return "context trimmed";
  if (event.type === "context_compact") return "context compacted";
  if (event.type === "subagent_start") return `subagent start · ${event.agent || "?"}`;
  if (event.type === "subagent_end") return `subagent end · ${event.agent || "?"} · ${event.ok ? "ok" : "failed"}`;
  if (event.type === "mission_start") return `mission start · ${event.name || event.missionId}`;
  if (event.type === "mission_step_start") return `mission step ${event.id || "?"}`;
  if (event.type === "mission_step_end") return `mission step ${event.id || "?"} ${event.ok ? "ok" : "failed"}`;
  if (event.type === "mission_end") return `mission end · ${event.status || "done"}`;
  return "";
}

export function summarizeAgentRun(events = []) {
  const stats = {
    steps: 0,
    toolCalls: 0,
    toolFailures: 0,
    modelTurns: 0,
    totalToolMs: 0,
    totalModelMs: 0,
    durationMs: 0,
    tokens: 0,
    status: "unknown"
  };
  for (const event of events) {
    if (event.type === "model_start") stats.modelTurns += 1;
    if (event.type === "model_end") {
      stats.steps = Math.max(stats.steps, event.step || 0);
      stats.toolCalls += event.toolCalls || 0;
      stats.totalModelMs += event.durationMs || 0;
      stats.tokens += event.usage?.total_tokens || 0;
    }
    if (event.type === "tool_end") {
      stats.totalToolMs += event.durationMs || 0;
      if (!event.ok) stats.toolFailures += 1;
    }
    if (event.type === "final") stats.status = "ok";
    if (event.type === "step_limit") stats.status = "step_limit";
    if (event.type === "agent_run_end") {
      stats.status = event.status || stats.status;
      stats.durationMs = event.durationMs || stats.durationMs;
    }
    if (event.type === "agent_error") stats.status = "error";
  }
  return stats;
}

export function formatAgentRunSummary(events = [], { style = "cli" } = {}) {
  const stats = summarizeAgentRun(events);
  const timing = stats.durationMs
    ? (style === "cli" ? `${stats.durationMs}ms` : prettyMs(stats.durationMs))
    : "";
  const parts = [
    stats.status,
    stats.steps ? `${stats.steps} step${stats.steps === 1 ? "" : "s"}` : null,
    stats.toolCalls ? `${stats.toolCalls} tool${stats.toolCalls === 1 ? "" : "s"}` : null,
    stats.toolFailures ? `${stats.toolFailures} failed` : null,
    timing || null,
    stats.tokens ? `${stats.tokens} tok` : null
  ].filter(Boolean);
  return parts.join(" · ") || "no activity";
}

export function formatAgentRunStats(events = [], { maxSteps = null } = {}) {
  const runStats = summarizeAgentRun(events);
  const cap = maxSteps
    || events.find((event) => event.maxSteps)?.maxSteps
    || null;
  const usage = extractUsageFromEvents(events);
  const result = {
    status: runStats.status,
    steps: runStats.steps || null,
    maxSteps: cap,
    toolCalls: runStats.toolCalls || null,
    toolFailures: runStats.toolFailures || null,
    duration: runStats.durationMs ? prettyMs(runStats.durationMs) : null,
    tokens: runStats.tokens || null,
    modelMs: runStats.totalModelMs ? prettyMs(runStats.totalModelMs) : null,
    toolMs: runStats.totalToolMs ? prettyMs(runStats.totalToolMs) : null,
    model: usage.model || null,
    inputTokens: usage.inputTokens || null,
    outputTokens: usage.outputTokens || null
  };
  if (result.model && typeof estimateCost === "function") {
    const cost = estimateCost(
      result.model,
      result.inputTokens || 0,
      result.outputTokens || 0
    );
    if (cost) {
      result.cost = `$${cost.totalCost.toFixed(4)}`;
      result.costValue = cost.totalCost;
    }
  }
  return result;
}

export function formatSessionEvents(events, { maxSteps = null, style = "cli" } = {}) {
  const report = formatAgentRunReport(events, { maxSteps, style });
  return report || "(no events recorded)";
}

export function formatSessionTranscript(session, { style = "cli", maxToolChars = 2000 } = {}) {
  if (session?.events?.length) {
    const eventBlock = formatSessionEvents(session.events, { style });
    const header = style === "tui"
      ? `${brand(icon("chevronRight"))} ${muted(session.prompt || "(no prompt)")}`
      : `prompt: ${session.prompt || ""}`;
    return [header, "", style === "tui" ? muted("events:") : "events:", eventBlock].join("\n");
  }

  const lines = [];
  for (const message of session?.messages || []) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      lines.push(style === "tui"
        ? `${brand(icon("chevronRight"))} ${brand("assistant")}: ${message.content || ""}`
        : `assistant: ${message.content || ""}`);
      for (const call of message.tool_calls || []) {
        const args = call.function?.arguments || "{}";
        const tool = call.function?.name || "tool";
        lines.push(style === "tui"
          ? `  ${muted(icon("arrow"))} ${muted(tool)} ${muted(args)}`
          : `assistant tool_call: ${tool} ${args}`);
      }
    } else if (message.role === "tool") {
      const content = String(message.content || "").slice(0, maxToolChars);
      lines.push(style === "tui"
        ? `  ${muted(icon("bullet"))} ${muted(`tool ${message.name || ""}`.trim())}: ${content}`
        : `tool ${message.name}: ${content}`);
    } else {
      lines.push(style === "tui"
        ? `${muted(message.role || "message")}: ${message.content || ""}`
        : `${message.role}: ${message.content || ""}`);
    }
  }
  const empty = style === "tui" ? muted("(empty transcript)") : "(empty transcript)";
  return lines.join("\n") || empty;
}

export function createEventCollector() {
  const events = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    }
  };
}

const PROGRESS_QUIET_EVENTS = new Set(["model_start", "model_end", "agent_run_start", "agent_run_end"]);
const GROK_QUIET_EVENTS = new Set(["final", "agent_run_start", "agent_run_end", "model_start"]);

export function createAgentProgress({
  spinner = null,
  maxSteps = null,
  style = "tui",
  onLine = null,
  filter = null,
  quietModelTurns = false,
  onProgress = null,
  panelWidth = null
} = {}) {
  const write = onLine || ((line) => console.log(line));
  const clearWidth = spinner?.stream?.columns || process.stdout.columns || 80;
  const eventStyle = style === "rich" || style === "grok" ? style : style;
  let lastTool = null;
  return (event) => {
    if (style === "grok" && GROK_QUIET_EVENTS.has(event?.type)) {
      if (event?.type === "model_start" && event.step) {
        onProgress?.({ step: event.step, maxSteps: event.maxSteps ?? maxSteps, tool: lastTool, phase: "thinking", event });
      }
      return;
    }
    if (quietModelTurns && PROGRESS_QUIET_EVENTS.has(event?.type)) {
      const grokThought = style === "grok" && event?.type === "model_end";
      if (!grokThought) {
        if (event?.type === "model_start" && event.step) {
          onProgress?.({ step: event.step, maxSteps: event.maxSteps ?? maxSteps, tool: lastTool, phase: "thinking", event });
        }
        return;
      }
    }
    if (filter && !filter(event)) return;
    const limit = event.maxSteps ?? maxSteps;
    if (event?.type === "tool_start") lastTool = event.tool || lastTool;
    if ((style === "rich" || style === "grok") && event?.type === "tool_start") {
      if (spinner) {
        updateSpinnerLabel(spinnerRunLabel({
          step: event.step,
          maxSteps: limit,
          tool: event.tool || lastTool,
          width: Math.min(18, Math.max(10, Math.floor(clearWidth / 6)))
        }));
      }
      onProgress?.({
        step: event.step || 0,
        maxSteps: limit,
        tool: event.tool || lastTool,
        phase: event.type,
        event
      });
      return;
    }
    if (event?.type === "tool_end" && event.ok) lastTool = null;
    const line = formatAgentStepLine(event, { maxSteps: limit, style: eventStyle, width: panelWidth || clearWidth });
    if (line) {
      if (spinner?.tty) spinner.stream.write(`\r${" ".repeat(clearWidth)}\r`);
      write(line, event);
      for (const extra of formatAgentStepExtras(event, { style: eventStyle, width: panelWidth || clearWidth })) {
        write(extra, event);
      }
    }
    if (spinner) {
      if (style === "rich" && event.step && limit) {
        const phase = event.type === "tool_start"
          ? event.tool
          : event.type === "model_start"
            ? "thinking"
            : event.type === "final"
              ? "finishing"
              : lastTool || "working";
        updateSpinnerLabel(spinnerRunLabel({
          step: event.step,
          maxSteps: limit,
          tool: phase,
          width: Math.min(18, Math.max(10, Math.floor(clearWidth / 6)))
        }));
      } else {
        const short = formatAgentEvent(event, { style: style === "rich" ? "tui" : style });
        if (short) updateSpinnerLabel(short);
      }
    }
    onProgress?.({
      step: event.step || 0,
      maxSteps: limit,
      tool: event.tool || lastTool,
      phase: event.type,
      tokens: event.usage?.total_tokens,
      event
    });
  };
}

export function formatRuntimeGuardLine(cfg, cwd = process.cwd()) {
  return formatGuard(gitGuard(cwd, cfg));
}

export function formatToolRunLine(run, { style = "cli" } = {}) {
  if (!run) return "";
  const summary = summarizeToolArgs(run.name, run.args);
  const status = run.ok ? "ok" : "failed";
  const timing = style === "cli" ? `${run.durationMs}ms` : prettyMs(run.durationMs);
  const detail = summary ? ` ${summary}` : "";
  return `${run.name}${detail} · ${status} · ${timing}`;
}

export function formatSessionCreated(createdAt) {
  if (!createdAt) return "";
  const ageMs = Date.now() - new Date(createdAt).getTime();
  if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) {
    return `${prettyMs(ageMs)} ago`;
  }
  return String(createdAt).slice(0, 19);
}

export function sessionListEntries(sessions = {}, { promptLimit = 80 } = {}) {
  return Object.entries(sessions)
    .sort((left, right) => String(right[1]?.createdAt || "").localeCompare(String(left[1]?.createdAt || "")))
    .map(([id, item]) => {
      const stats = summarizeAgentRun(item.events || []);
      const status = item.stopped || (item.events?.length ? stats.status : "ok");
      return {
        id,
        created: formatSessionCreated(item.createdAt),
        mode: item.mode || "",
        status,
        steps: stats.steps || 0,
        tools: stats.toolCalls || 0,
        duration: stats.durationMs ? prettyMs(stats.durationMs) : "",
        tokens: stats.tokens || 0,
        prompt: String(item.prompt || "").slice(0, promptLimit)
      };
    });
}

export function toolRunListEntries(toolRuns = [], { limit = 20 } = {}) {
  return (toolRuns || []).slice(-limit).reverse().map((run) => ({
    at: formatSessionCreated(run.at) || run.at || "",
    session: run.sessionId || "",
    step: run.step ?? "",
    tool: run.name || "",
    summary: summarizeToolArgs(run.name, run.args),
    ok: run.ok ? "ok" : "failed",
    ms: run.durationMs ?? ""
  }));
}

export function extractUsageFromEvents(events = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let model = null;
  for (const event of events) {
    if (event.type === "model_end" && event.usage) {
      inputTokens += event.usage.prompt_tokens || event.usage.input_tokens || 0;
      outputTokens += event.usage.completion_tokens || event.usage.output_tokens || 0;
      if (event.model) model = event.model;
    }
  }
  return { inputTokens, outputTokens, model, totalTokens: inputTokens + outputTokens };
}

export async function withAgentAbort(fn, { onCancel = null } = {}) {
  const controller = new AbortController();
  let sigints = 0;
  const onSigint = () => {
    sigints += 1;
    if (sigints === 1 && !controller.signal.aborted) {
      controller.abort();
      onCancel?.({ again: false });
      return;
    }
    if (sigints >= 2) process.exit(130);
  };
  process.on("SIGINT", onSigint);
  try {
    return await fn(controller.signal);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}