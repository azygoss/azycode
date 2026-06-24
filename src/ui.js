// Azycode UI primitives
// Dependency-free terminal rendering: colors, boxes, badges, tables, spinners, status pills.
// All helpers degrade to plain text when the terminal does not advertise color.
//
// Layered architecture (see plan.md §2.4):
//   - src/ui/ansi.js   : color detection, ANSI palette, style/width helpers, wrapText
//   - src/ui/layout.js : rule, frame, box, panel, modeColor
//   - src/ui/cost.js   : MODEL_PRICING, estimateCost, cost display
// This module re-exports those primitives and builds higher-level components
// (welcome screen, tool cards, diff blocks, error panels, etc.) on top of them.

import { stdout, stderr, env } from "node:process";

// Re-export the foundational layers so existing `from "./ui.js"` imports keep
// working without any call-site changes.
export {
  detectColor, colorsEnabled, trueColorEnabled, ANSI, namedColors,
  style, paint, muted, subtle, faint, accent, success, warn, error, info, brand,
  dim, bold, cyan, green, yellow, red,
  visibleLength, padEnd, padStart, truncate, stripAnsi, sliceVisible, skipVisible, wrapText
} from "./ui/ansi.js";
export { modeColor, FRAME, rule, frame, box, panel } from "./ui/layout.js";
export {
  MODEL_PRICING, estimateCost, formatTokenCount, formatUSD, costColor,
  costDisplay, costSummaryPanel
} from "./ui/cost.js";

// Pull the primitives into local scope for use by the higher-level components below.
import { colorsEnabled, ANSI, namedColors } from "./ui/ansi.js";
import {
  style, paint, muted, subtle, faint, accent, success, warn, error, info, brand,
  dim, bold, cyan, green, yellow, red,
  visibleLength, padEnd, padStart, truncate, stripAnsi, sliceVisible, skipVisible, wrapText
} from "./ui/ansi.js";
import { modeColor, FRAME, rule, frame, box as internalBox, panel } from "./ui/layout.js";
import {
  MODEL_PRICING, estimateCost, formatTokenCount, formatUSD, costColor,
  costDisplay, costSummaryPanel
} from "./ui/cost.js";

const PANEL_TITLE_ICONS = {
  task: "chevronRight",
  assistant: "sparkle",
  "run complete": "check",
  ready: "diamond",
  setup: "warn",
  status: "info",
  dashboard: "mission",
  confirm: "warn",
  shell: "terminal",
  help: "info",
  commands: "chevron",
  preview: "file",
  diff: "edit"
};

// ---------------------------------------------------------------------------
// Style primitives — imported from src/ui/ansi.js (see header).
// The semantic color shortcuts, width helpers, and wrapText live in the ansi
// layer; this section only contains higher-level composer/screen helpers.
// ---------------------------------------------------------------------------

export function grokComposerLine({
  model = null,
  mode = null,
  reasoning = null,
  agent = null,
  messages = null,
  maxMessages = null,
  width = stdout?.columns
} = {}) {
  const bits = [
    model ? brand(truncate(model, 40)) : null,
    mode ? chip(mode, "accent") : null,
    reasoning ? chip(reasoning, "info") : null,
    agent ? chip(`@${agent}`, "brand") : null,
    messages != null && maxMessages != null ? chip(`${messages}/${maxMessages} msg`, "muted") : null
  ].filter(Boolean);
  if (!bits.length) return "";
  const right = bits.join(`  ${subtle("·")}  `);
  const cols = Math.max(40, Number(width) || 80);
  const gap = cols - visibleLength(right);
  return gap > 0 ? `${" ".repeat(gap)}${right}` : right;
}


export function grokShortcutLine() {
  return [
    `${subtle("keys")}`,
    `${bold("Shift+Tab")} ${muted("mode")}`,
    `${bold("Tab")} ${muted("reasoning")}`,
    `${bold("/")} ${muted("commands")}`,
    `${bold("↑↓")} ${muted("pick")}`,
    `${bold("!")} ${muted("shell")}`
  ].join(`  ${subtle("·")}  `);
}


export function grokComposerDock({
  model = null,
  mode = null,
  reasoning = null,
  agent = null,
  messages = null,
  maxMessages = null,
  width = stdout?.columns
} = {}) {
  const W = Math.max(48, Number(width) || 80);
  const lines = [];
  const composer = grokComposerLine({ model, mode, reasoning, agent, messages, maxMessages, width: W });
  if (composer) {
    lines.push(subtle("  " + "─".repeat(Math.max(0, W - 4))));
    lines.push(composer);
  }
  lines.push(`  ${grokShortcutLine()}`);
  return lines;
}


export function grokWelcomeScreen({
  connected = false,
  workspace = "workspace",
  branch = null,
  width = stdout?.columns
} = {}) {
  const lines = [];
  const pulse = connected ? success("●") : warn("●");
  const statusWord = connected ? success("ready") : warn("setup");
  const place = grokWorkspaceLabel(workspace, branch);
  lines.push(`  ${brand(icon("diamond"))} ${bold(brand("azycode"))}  ${pulse} ${statusWord}  ${place}`);
  lines.push(`  ${muted("What should we work on?")}  ${subtle("/help for commands")}`);
  if (!connected) lines.push(`  ${warn(`${icon("warn")} connect with /login`)}`);
  return lines;
}


export function isSpinnerActive() {
  return Boolean(activeSpinner);
}


export function pill(text, color = "muted") {
  return style(` ${text} `, color);
}


export function quoteBlock(text, { width = 80 } = {}) {
  const inner = Math.max(16, width - 6);
  const lines = wrapText(String(text ?? "").trim(), inner);
  if (!lines.length || (lines.length === 1 && !lines[0])) return [muted("(empty)")];
  return lines.map((line, index) => {
    const lead = index === 0 ? brand(icon("prompt")) : faint("  ");
    const body = index === 0 ? bold(accent(line)) : muted(line);
    return `${lead} ${body}`;
  });
}


export function runSummaryPanel(stats, { width, title = "run complete" } = {}) {
  const statusTone = stats.status === "ok" ? "success" : stats.status === "error" ? "error" : "warn";
  const headline = [
    stats.status === "ok" ? success(icon("check")) : stats.status === "error" ? error(icon("cross")) : warn(icon("warn")),
    bold(style(stats.status || "done", statusTone)),
    stats.steps != null ? chip(`${stats.steps} step${stats.steps === 1 ? "" : "s"}`, "info") : null,
    stats.toolCalls != null ? chip(`${stats.toolCalls} tool${stats.toolCalls === 1 ? "" : "s"}`, "accent") : null,
    stats.toolFailures ? chip(`${stats.toolFailures} failed`, "error") : null,
    stats.duration ? chip(stats.duration, "muted") : null,
    stats.tokens ? chip(`${stats.tokens} tok`, "faint") : null
  ].filter(Boolean).join(` ${faint("·")} `);
  const timing = statCells([
    stats.modelMs ? { label: "model", value: stats.modelMs, style: "info" } : null,
    stats.toolMs ? { label: "tools", value: stats.toolMs, style: "accent" } : null,
    stats.steps && stats.maxSteps ? { label: "budget", value: `${stats.steps}/${stats.maxSteps}`, style: "muted" } : null
  ].filter(Boolean));
  const rows = [];
  if (headline) rows.push(headline);
  if (timing) rows.push(faint(timing));
  if (!rows.length) rows.push(muted("no activity"));
  return box(rows, { width, title, titleTone: "success", frame: "rounded", color: "borderSoft", padding: 1 });
}


export function spinnerFrames() {
  return SPINNER_FRAMES.slice();
}


export function tag(text, color = "muted") {
  return style(text, color);
}


export function tree(items, { indent = 2, prefix = "" } = {}) {
  const lines = [];
  const stack = items.map((item, index) => ({ item, depth: 0, last: index === items.length - 1 }));
  while (stack.length) {
    const { item, depth, last } = stack.shift();
    if (typeof item === "string") {
      const branch = depth === 0 ? "" : `${" ".repeat(indent * depth)}${style(last ? "└─" : "├─", "subtle")} `;
      lines.push(`${prefix}${branch}${item}`);
    } else {
      const head = item.head ?? "";
      const branch = `${" ".repeat(indent * depth)}${style(last ? "└─" : "├─", "subtle")} `;
      const headText = head ? `${item.style ? style(head, item.style) : head}` : "";
      const meta = item.meta ? ` ${style(item.meta, "muted")}` : "";
      lines.push(`${prefix}${branch}${headText}${meta}`);
      const children = item.children || [];
      children.forEach((child, index) => {
        stack.push({ item: child, depth: depth + 1, last: index === children.length - 1 });
      });
    }
  }
  return lines;
}


export function wordmark({ version = "v0.1", tagline = "interactive coding harness", connected = null } = {}) {
  const mark = `${brand(icon("diamond"))} ${bold(brand("azycode"))} ${faint("·")} ${muted(tagline)}`;
  const status = connected == null
    ? muted("local agent")
    : chip(connected ? "online" : "offline", connected ? "success" : "warn");
  const meta = `${chip(version, "faint")}  ${status}`;
  return [mark, meta];
}



// (style, paint, semantic color shortcuts, width helpers, truncate, stripAnsi,
// sliceVisible, skipVisible, and wrapText are imported from src/ui/ansi.js.)

// ---------------------------------------------------------------------------
// Time + numeric formatting
// ---------------------------------------------------------------------------

export function prettyMs(ms, { compact = true } = {}) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1) return "<1ms";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) {
    const seconds = value / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  if (compact) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.round((value % 60_000) / 1000);
    return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function prettyElapsed(start) {
  return prettyMs(Date.now() - start, { compact: true });
}

// ---------------------------------------------------------------------------
// Icons + spinner frames
// ---------------------------------------------------------------------------

const ICONS = {
  bullet: "●",
  circle: "○",
  check: "✓",
  cross: "✗",
  warn: "⚠",
  arrow: "→",
  arrowUp: "↑",
  arrowDown: "↓",
  chevron: "›",
  chevronRight: "▸",
  chevronDown: "▾",
  dot: "•",
  diamond: "◆",
  square: "■",
  squareEmpty: "□",
  triangle: "▴",
  triangleDown: "▾",
  lock: "⌘",
  enter: "⏎",
  backspace: "⌫",
  option: "⌥",
  star: "★",
  starEmpty: "☆",
  spike: "⏵",
  info: "ℹ",
  link: "↗",
  prompt: "›",
  terminal: "⎕",
  file: "◇",
  search: "⌕",
  edit: "✎",
  git: "⎇",
  agent: "◎",
  mission: "◈",
  stream: "≋",
  paperclip: "⧉",
  plus: "+",
  minus: "−",
  sparkle: "✦"
};

export function icon(name) {
  return ICONS[name] ?? "";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(index) {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return SPINNER_FRAMES[((i % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

// ---------------------------------------------------------------------------
// Badges + status markers
// ---------------------------------------------------------------------------

export function badge(value) {
  const text = String(value ?? "");
  if (value === true || text === "ok" || text === "enabled" || text === "active" || text === "configured" || text === "connected") return style(`● ${text}`, "success");
  if (value === false || text === "failed" || text === "disabled" || text === "inactive" || text === "denied" || text === "blocked") return style(`● ${text}`, "error");
  if (text === "warn" || text === "warning" || text === "pending") return style(`● ${text}`, "warn");
  return style(`● ${text}`, "muted");
}

export function statusDot(state = "ok") {
  if (state === "ok" || state === "active" || state === "connected" || state === true) return style("●", "success");
  if (state === "warn" || state === "warning" || state === "pending") return style("●", "warn");
  if (state === "error" || state === "failed" || state === "blocked" || state === false) return style("●", "error");
  return style("●", "muted");
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export function promptStatus({
  mode,
  reasoning,
  agent = null,
  profile = null,
  guard = "ok",
  messages = 0,
  maxMessages = null,
  tokens = null
} = {}) {
  const parts = [];
  parts.push(mode ? style(mode, modeColor(mode)) : style("—", "muted"));
  parts.push(reasoning ? style(reasoning, "info") : style("—", "muted"));
  if (agent) parts.push(style(`@${agent}`, "brand"));
  if (profile && profile !== "normal") parts.push(style(profile, "accent"));
  if (messages > 0) {
    const label = maxMessages ? `${messages}/${maxMessages}` : String(messages);
    const ratio = maxMessages ? messages / maxMessages : 0;
    const color = ratio >= 0.9 ? "warn" : ratio >= 0.7 ? "accent" : "muted";
    parts.push(style(`${label} msg`, color));
  }
  if (tokens) parts.push(style(`${tokens} tok`, "faint"));
  if (guard && guard !== "ok") parts.push(style(guard, guard === "blocked" ? "error" : "warn"));
  return parts.join(style(" │ ", "subtle"));
}

// (modeColor, FRAME, rule, frame, and panel are imported from src/ui/layout.js.)
// `box` is a local wrapper that injects the higher-level panelTitle renderer
// (an icon + tone chip defined below) so titled boxes keep their rich titles
// while the layout primitive itself stays free of components-layer dependencies.
function box(rows, options = {}) {
  return internalBox(rows, { ...options, titleRenderer: panelTitle });
}

// ---------------------------------------------------------------------------
// Backward-compatible section/title helpers
// ---------------------------------------------------------------------------

export function title(text) {
  console.log(style(text, "bold"));
}

export function section(text) {
  console.log("");
  console.log(style(text, "cyan"));
}

export function kv(key, value) {
  console.log(`${String(key).padEnd(18)} ${value ?? ""}`);
}

export function list(items) {
  for (const item of items) console.log(`  ${item}`);
}

export function table(rows, columns, { maxWidth = stdout?.columns || 80 } = {}) {
  if (!rows.length) return;
  const sep = "  ";
  let widths = columns.map((column) => {
    const cells = rows.map((row) => visibleLength(String(row[column.key] ?? "")));
    return Math.max(column.label.length, ...cells);
  });
  widths = clampTableWidths(widths, columns.length, sep.length, maxWidth);
  console.log(columns.map((column, index) => {
    const label = renderCell(column.label, widths, index, columns.length);
    return style(label, "dim");
  }).join(sep));
  for (const row of rows) {
    console.log(columns.map((column, index) => {
      const cell = String(row[column.key] ?? "");
      return renderCell(cell, widths, index, columns.length);
    }).join(sep));
  }
}

// ponytail: shared width-clamp for table/renderTable. Shrinks the last column
// (and any overflow) so wide tables truncate with "…" instead of wrapping.
function clampTableWidths(widths, colCount, sepLen, maxWidth) {
  const total = widths.reduce((sum, w) => sum + w, 0) + sepLen * (colCount - 1);
  if (total <= maxWidth || colCount === 0) return widths;
  const last = colCount - 1;
  const reserved = widths.reduce((sum, w, i) => i === last ? sum : sum + w, 0) + sepLen * (colCount - 1);
  const lastWidth = Math.max(8, maxWidth - reserved);
  return widths.map((w, i) => i === last ? lastWidth : w);
}

function renderCell(value, widths, index, colCount) {
  const text = String(value ?? "");
  if (index === colCount - 1) return truncate(text, widths[index]);
  return padEnd(text, widths[index]);
}

// ---------------------------------------------------------------------------
// New richer table renderer
// ---------------------------------------------------------------------------

export function renderTable(rows, columns, options = {}) {
  const { header = true, border = true, headerColor = "muted", zebra = false, maxWidth = stdout?.columns || 80 } = options;
  if (!rows.length && !header) return [];
  let widths = columns.map((column) => {
    const cells = rows.map((row) => visibleLength(String(row[column.key] ?? "")));
    const headerLen = column.label ? visibleLength(column.label) : 0;
    return Math.max(headerLen, ...cells, column.minWidth || 0);
  });
  widths = clampTableWidths(widths, columns.length, "  ".length, maxWidth);
  const sep = "  ";
  const out = [];
  if (header) {
    const headerRow = columns.map((column, index) => style(padEnd(truncate(column.label || "", widths[index]), widths[index]), headerColor)).join(sep);
    out.push(headerRow);
    if (border) {
      out.push(style(columns.map((column, index) => "─".repeat(widths[index])).join(sep), "rule"));
    }
  }
  rows.forEach((row, rowIndex) => {
    const isZebra = zebra && rowIndex % 2 === 1;
    out.push(columns.map((column, index) => {
      const rendered = renderCell(String(row[column.key] ?? ""), widths, index, columns.length);
      return isZebra ? dim(rendered) : rendered;
    }).join(sep));
  });
  return out;
}

// ---------------------------------------------------------------------------
// Key-value list with right-aligned values, optional title and box frame
// ---------------------------------------------------------------------------

export function keyValueList(rows, { boxed = false, frame: frameName = "rounded", title = null, width } = {}) {
  if (!rows.length) return [];
  const longestKey = rows.reduce((max, [key]) => Math.max(max, visibleLength(String(key ?? ""))), 0);
  const rendered = rows.map(([key, value]) => `${subtle(padEnd(String(key ?? ""), longestKey))}  ${value ?? ""}`);
  if (boxed) {
    return box(rendered, { width, frame: frameName, title });
  }
  return rendered;
}

// ---------------------------------------------------------------------------
// Tree-like output
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spinner runtime (used by TUI for "working..." state)
// ---------------------------------------------------------------------------

let activeSpinner = null;
let activeTimer = null;
let activeStart = 0;

export function startSpinner({ label = "working", stream = stderr, isTTY = stream?.isTTY, interval = 80 } = {}) {
  if (activeSpinner) stopSpinner();
  if (!colorsEnabled || !isTTY) {
    activeSpinner = { label, frame: 0, stream, isTTY: false, tty: false };
    console.log(`${muted(`${label}…`)}`);
    return activeSpinner;
  }
  activeStart = Date.now();
  activeSpinner = { label, frame: 0, stream, isTTY: true, tty: true, interval };
  const render = () => {
    if (!activeSpinner || !activeSpinner.tty) return;
    const elapsed = prettyElapsed(activeStart);
    const frame = spinnerFrame(activeSpinner.frame);
    const text = `${style(frame, "brand")} ${activeSpinner.label} ${muted(elapsed)}`;
    stream.write(`\r${" ".repeat(stream.columns || 80)}\r${text}`);
    activeSpinner.frame += 1;
  };
  render();
  activeTimer = setInterval(render, interval);
  return activeSpinner;
}

export function updateSpinnerLabel(label) {
  if (activeSpinner) activeSpinner.label = label;
}

export function stopSpinner({ clear = true, finalLabel = null, finalStyle = "success" } = {}) {
  if (!activeSpinner) return;
  if (activeTimer) clearInterval(activeTimer);
  activeTimer = null;
  const wasTty = activeSpinner.tty;
  const elapsed = prettyElapsed(activeStart);
  if (wasTty && clear) {
    activeSpinner.stream.write(`\r${" ".repeat(activeSpinner.stream.columns || 80)}\r`);
  }
  if (finalLabel) {
    const symbol = finalStyle === "error" ? style("✗", "error") : style("✓", "success");
    const text = `${symbol} ${finalLabel} ${muted(elapsed)}`;
    console.log(text);
  }
  activeSpinner = null;
  activeStart = 0;
}

// ---------------------------------------------------------------------------
// Indented block (multiline content with hanging indent)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Code block (subtle background look using dim)
// ---------------------------------------------------------------------------

export function code(text) {
  return style(String(text ?? ""), "muted");
}

// ---------------------------------------------------------------------------
// Stderr/stdout helpers
// ---------------------------------------------------------------------------

export function blank() {
  console.log("");
}

export function header(text) {
  const w = Math.max(40, visibleLength(text) + 8);
  return rule(w, { label: text, color: "panel", labelColor: "info" });
}

// ---------------------------------------------------------------------------
// Rich TUI layout helpers (welcome, timeline, run summary, response blocks)
// ---------------------------------------------------------------------------

export function contentWidth(columns = stdout?.columns, { min = 60, max = 96, padding = 4 } = {}) {
  const cols = Number(columns) || max;
  const usable = Math.max(20, cols - padding);
  if (cols < min) return usable;
  return Math.min(usable, max);
}

export function chip(text, tone = "muted") {
  const value = String(text ?? "");
  return `${subtle("[")}${style(value, tone)}${subtle("]")}`;
}

export function paletteHintLine(hints = []) {
  return `  ${hints.map(({ key, label }) => `${bold(key)} ${muted(label)}`).join("  ")}`;
}

function grokWorkspaceLabel(workspace = "workspace", branch = null) {
  const name = String(workspace);
  const hideRepo = name.toLowerCase() === "azycode";
  if (branch && branch !== "unknown") {
    return hideRepo ? info(branch) : `${muted(name)}${subtle("/")}${info(branch)}`;
  }
  return accent(name);
}

export function panelTitle(title, { tone = "brand", icon: iconName = null } = {}) {
  const key = String(title ?? "").toLowerCase();
  const glyph = iconName || PANEL_TITLE_ICONS[key];
  const prefix = glyph ? `${style(icon(glyph), tone)} ` : "";
  return `${prefix}${style(String(title ?? ""), tone)}`;
}

export function progressBar(current, max, width = 24, { tone = null } = {}) {
  const value = Math.max(0, Number(current) || 0);
  const cap = Math.max(1, Number(max) || 1);
  const inner = Math.max(4, width - 2);
  const filled = Math.min(inner, Math.round((value / cap) * inner));
  const empty = inner - filled;
  const ratio = value / cap;
  const fillTone = tone || (ratio >= 0.92 ? "error" : ratio >= 0.75 ? "warn" : "brand");
  const bar = `${style("█".repeat(filled), fillTone)}${style("░".repeat(empty), "faint")}`;
  return `[${bar}] ${muted(`${value}/${cap}`)}`;
}

function renderInlineMarkdown(text) {
  let value = String(text ?? "");
  value = value.replace(/\*\*([^*]+)\*\*/g, (_, inner) => bold(accent(inner)));
  value = value.replace(/\*([^*]+)\*/g, (_, inner) => style(inner, "italic"));
  value = value.replace(/`([^`]+)`/g, (_, inner) => code(inner));
  return value;
}

export function formatMarkdownLine(line) {
  const text = String(line ?? "");
  if (/^#{1,3}\s/.test(text)) return bold(brand(text.replace(/^#+\s*/, "")));
  if (/^```/.test(text)) return faint(text);
  if (/^[-*•]\s/.test(text)) return `  ${success(icon("bullet"))} ${renderInlineMarkdown(text.replace(/^[-*•]\s/, ""))}`;
  if (/^\d+\.\s/.test(text)) return `  ${muted(text.match(/^\d+/)[0] + ".")} ${renderInlineMarkdown(text.replace(/^\d+\.\s/, ""))}`;
  if (/\*\*|`|^\*[^*]/.test(text)) return renderInlineMarkdown(text);
  return text;
}

export function highlightTerms(text, terms = []) {
  const value = String(text ?? "");
  const normalized = terms.map((term) => term.toLowerCase()).filter(Boolean);
  if (!normalized.length || !colorsEnabled) return value;
  const lower = value.toLowerCase();
  let best = null;
  for (const term of normalized) {
    const index = lower.indexOf(term);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, term };
  }
  if (!best) return value;
  const before = value.slice(0, best.index);
  const match = value.slice(best.index, best.index + best.term.length);
  const after = value.slice(best.index + best.term.length);
  return `${before}${style(match, "brand")}${after}`;
}

export function brandBanner(rows, { width, frame: frameName = "rounded", color = "border", title = null, titleTone = "brand" } = {}) {
  return box(rows, { width, frame: frameName, color, title, titleTone, padding: 2 });
}

export function timelineRow({
  glyph = icon("bullet"),
  glyphStyle = "muted",
  label = "",
  detail = "",
  meta = "",
  status = null,
  indent = 0,
  branch = null
} = {}) {
  const pad = " ".repeat(Math.max(0, indent * 2));
  const branchText = branch === "last"
    ? style("╰─", "faint")
    : branch === "mid"
      ? style("├─", "faint")
      : branch === "cont"
        ? style("│ ", "faint")
        : "";
  const iconText = style(glyph, glyphStyle);
  const statusText = status
    ? ` ${status === "ok" || status === true ? success(icon("check")) : status === "warn" ? warn(icon("warn")) : error(icon("cross"))}`
    : "";
  const detailText = detail ? ` ${typeof detail === "string" && !detail.includes("\x1b") ? muted(detail) : detail}` : "";
  const metaText = meta ? ` ${typeof meta === "string" && !meta.includes("\x1b") ? faint(meta) : meta}` : "";
  const spacer = branchText ? `${branchText} ` : "";
  return `${pad}${spacer}${iconText}  ${label}${detailText}${metaText}${statusText}`;
}

export function statCells(stats, { separator = null } = {}) {
  const sep = separator ?? style(" │ ", "subtle");
  return stats
    .filter((item) => item && item.value != null && item.value !== "")
    .map((item) => {
      const label = item.label ? muted(`${item.label} `) : "";
      const value = item.style ? style(String(item.value), item.style) : bold(String(item.value));
      return `${label}${value}`;
    })
    .join(sep);
}

export function responsePanel(content, { width, title = "assistant", frame: frameName = "rounded" } = {}) {
  const text = String(content ?? "").trim();
  if (!text) return box([muted("(no response)")], { width, title, titleTone: "info", frame: frameName, color: "border", padding: 2 });
  const lines = [];
  const blocks = text.split(/\n{2,}/);
  for (const [index, block] of blocks.entries()) {
    if (index > 0) lines.push("");
    lines.push(...block.split("\n").map((line) => formatMarkdownLine(line)));
  }
  return box(lines, { width, title, titleTone: "info", frame: frameName, color: "border", padding: 2 });
}

export function miniPanel(rows, { width = 60, title = null, frame: frameName = "rounded" } = {}) {
  const body = (rows || []).filter(Boolean);
  if (!body.length) return [];
  return box(body, {
    width: Math.min(width, 72),
    title: title || "preview",
    titleTone: "accent",
    frame: frameName,
    color: "borderSoft",
    padding: 1
  });
}

export function palettePanel(groups, { width, footer = null, highlight = [] } = {}) {
  const rows = [];
  const terms = Array.isArray(highlight) ? highlight : [];
  for (const group of groups) {
    if (!group.items?.length) continue;
    rows.push(`${brand(icon("chevronRight"))} ${bold(group.title)}`);
    const commandWidth = group.items.reduce((max, [command]) => Math.max(max, String(command).length), 0);
    for (const [command, summary] of group.items) {
      const cmd = highlightTerms(style(String(command), "brightWhite"), terms);
      const desc = highlightTerms(muted(summary), terms);
      rows.push(`${padEnd(cmd, commandWidth + 2)}${muted(desc)}`);
    }
    rows.push("");
  }
  if (footer) rows.push(footer);
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return box(rows, { width, title: "commands", titleTone: "brand", frame: "rounded", color: "border", padding: 2 });
}

export function helpPanel(groups, { width, footer = null } = {}) {
  const rows = [];
  for (const group of groups) {
    rows.push(`${brand(icon("chevronRight"))} ${bold(group.title)}`);
    const commandWidth = group.items.reduce((max, [command]) => Math.max(max, String(command).length), 0);
    for (const [command, summary] of group.items) {
      rows.push(`${padEnd(style(String(command), "brightWhite"), commandWidth + 2)}${muted(summary)}`);
    }
    rows.push("");
  }
  if (footer) rows.push(footer);
  while (rows.length && rows[rows.length - 1] === "") rows.pop();
  return box(rows, { width, title: "help", titleTone: "brand", frame: "rounded", color: "border", padding: 2 });
}

export function listPanel(title, rows, { width, empty = "(none)" } = {}) {
  const w = Math.max(20, width || 80);
  const lines = [`  ${brand(icon("chevronRight"))} ${bold(title)}`];
  if (rows?.length) {
    for (const row of rows) lines.push(`  ${String(row ?? "")}`);
  } else {
    lines.push(`  ${muted(empty)}`);
  }
  return lines;
}

export function shellPanel(command, text, { width, title = "shell" } = {}) {
  const rows = [
    `${muted(icon("terminal"))} ${code(command)}`,
    "",
    ...(String(text ?? "").trim() ? String(text).trim().split("\n").map((line) => faint(line)) : [muted("(no output)")])
  ];
  return box(rows, { width, title, titleTone: "accent", frame: "rounded", color: "border", padding: 2 });
}

export function approvalPanel(question, { width, defaultAnswer = "n" } = {}) {
  return box([
    `${warn(icon("warn"))} ${bold("Approval required")}`,
    "",
    question,
    "",
    `${muted("Press")} ${chip(defaultAnswer === "y" ? "y" : "n", "warn")} ${muted("or")} ${chip(defaultAnswer === "y" ? "n" : "y", "muted")} ${muted("to continue")}`
  ], { width, title: "confirm", titleTone: "warn", frame: "rounded", color: "warn", padding: 2 });
}

export function diffLine(line) {
  const text = String(line ?? "");
  if (text.startsWith("+++") || text.startsWith("---") || text.startsWith("@@")) return faint(text);
  if (text.startsWith("+")) return success(text);
  if (text.startsWith("-")) return error(text);
  return muted(text);
}

export function diffBlock(text, { maxLines = 5, indent = 4, width, gutter = true } = {}) {
  const lines = String(text ?? "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => /^[+-]/.test(line) && !/^[+-]{3}/.test(line))
    .slice(0, maxLines);
  if (!lines.length) return [];
  const pad = " ".repeat(indent);
  const pipe = gutter ? `${style("│", "faint")} ` : "";
  return lines.map((line) => {
    const rendered = diffLine(line);
    const clipped = width ? truncate(rendered, Math.max(12, width - indent - 4)) : rendered;
    return `${pad}${pipe}${clipped}`;
  });
}

export function fileChangeBadge({ file, added = 0, removed = 0, action = "changed" } = {}) {
  const bits = [];
  if (file) bits.push(accent(file));
  if (added) bits.push(success(`+${added}`));
  if (removed) bits.push(error(`-${removed}`));
  if (!added && !removed && action) bits.push(muted(action));
  return bits.join(" ");
}

export function statusPanel(sections, { width, title = "status", frame: frameName = "rounded" } = {}) {
  const rows = [];
  for (const [index, section] of sections.entries()) {
    if (!section?.rows?.length) continue;
    if (index > 0) rows.push(rule(Math.max(20, (width || 60) - 6), { char: "·", color: "faint" }));
    if (section.title) rows.push(bold(brand(section.title)));
    rows.push(...section.rows);
  }
  if (!rows.length) rows.push(muted("(empty)"));
  return box(rows, { width, title, titleTone: "brand", frame: frameName, color: "border", padding: 2 });
}

export function spinnerRunLabel({ step = 0, maxSteps = null, tool = null, width = 16 } = {}) {
  const bar = maxSteps ? progressBar(step, maxSteps, width) : null;
  const phase = tool ? truncate(tool, 24) : "thinking";
  return [bar, phase].filter(Boolean).join("  ");
}

export function createStreamPanel({
  width,
  title = "assistant · streaming",
  stream = stdout,
  color = "border",
  onLine = null
} = {}) {
  const f = frame("rounded");
  const w = Math.max(24, width || 60);
  const inner = Math.max(8, w - 4);
  const margin = style(`${f.v} `, color);
  const emit = onLine || ((line) => {
    if (stream?.write) stream.write(`${line}\n`);
    else console.log(line);
  });
  let open = false;
  let buffer = "";

  function topLine() {
    const label = ` ${panelTitle(title, { tone: "info", icon: "stream" })} `;
    const remaining = w - 2 - visibleLength(label);
    const left = 1;
    const right = Math.max(0, remaining - left);
    return `${style(f.tl, color)}${style(f.h.repeat(left), color)}${label}${style(f.h.repeat(right), color)}${style(f.tr, color)}`;
  }

  function bottomLine() {
    return style(`${f.bl}${f.h.repeat(w - 2)}${f.br}`, color);
  }

  function emitContentLine(line) {
    for (const wrapped of wrapText(line, inner)) {
      emit(`${margin}${wrapped}`);
    }
  }

  function flushBuffer(final = false) {
    const parts = buffer.split("\n");
    if (!final) {
      buffer = parts.pop() ?? "";
      for (const part of parts) emitContentLine(part);
      return;
    }
    for (const part of parts) {
      if (part) emitContentLine(part);
    }
    buffer = "";
  }

  function openPanel() {
    if (open) return;
    open = true;
    emit(topLine());
  }

  function write(delta) {
    const text = String(delta ?? "");
    if (!text) return;
    openPanel();
    buffer += text;
    flushBuffer(false);
  }

  function close() {
    if (!open) return;
    flushBuffer(true);
    emit(bottomLine());
    open = false;
  }

  return { write, close, open: openPanel, isOpen: () => open };
}

// ---------------------------------------------------------------------------
// Grok Build-style stream layout (minimal chrome, diamond actions, flowing text)
// ---------------------------------------------------------------------------

export function grokTimeLabel(date = new Date()) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
}

export function grokActionRow(label, detail = "", { meta = null, timestamp = null, width = stdout?.columns } = {}) {
  const glyph = style(icon("diamond"), "brand");
  const head = typeof label === "string" && !label.includes("\x1b") ? bold(label) : label;
  const target = detail
    ? ` ${typeof detail === "string" && !detail.includes("\x1b") ? subtle(detail) : detail}`
    : "";
  const metaText = meta
    ? ` ${typeof meta === "string" && !meta.includes("\x1b") ? muted(meta) : meta}`
    : "";
  const left = `${glyph} ${head}${target}${metaText}`;
  if (!timestamp) return left;
  const cols = Math.max(40, Number(width) || 80);
  const ts = muted(timestamp);
  const gap = cols - visibleLength(left) - visibleLength(ts);
  return gap > 2 ? `${left}${" ".repeat(gap)}${ts}` : `${left}  ${ts}`;
}

export function grokUserBar(prompt, { width = stdout?.columns, timestamp = grokTimeLabel() } = {}) {
  const cols = Math.max(40, Number(width) || 80);
  const text = truncate(String(prompt ?? "").trim(), Math.max(24, cols - 14));
  const left = `${brand("›")} ${bold(style(text, "brightWhite"))}`;
  const ts = muted(timestamp);
  const gap = cols - visibleLength(left) - visibleLength(ts);
  return gap > 2 ? `${left}${" ".repeat(gap)}${ts}` : `${left}  ${ts}`;
}

export function grokRunMeta(stats = {}) {
  const bits = [];
  if (stats.duration) bits.push(stats.duration);
  if (stats.steps != null) bits.push(`${stats.steps} step${stats.steps === 1 ? "" : "s"}`);
  if (stats.toolCalls != null) bits.push(`${stats.toolCalls} tool${stats.toolCalls === 1 ? "" : "s"}`);
  if (stats.tokens) bits.push(`${stats.tokens} tok`);
  if (!bits.length) return "";
  return grokActionRow("Done", "", { meta: bits.join(" · ") });
}

export function renderGrokResponse(content, { width = stdout?.columns } = {}) {
  const text = String(content ?? "").trim();
  if (!text) return [muted("(no response)")];
  const inner = Math.max(40, (Number(width) || 80) - 4);
  const lines = [];
  for (const block of text.split(/\n{2,}/)) {
    if (lines.length) lines.push("");
    for (const raw of block.split("\n")) {
      for (const wrapped of wrapText(formatMarkdownLine(raw), inner)) {
        const body = wrapped.includes("\x1b") ? wrapped : style(wrapped, "brightWhite");
        lines.push(`  ${body}`);
      }
    }
  }
  return lines;
}

export function grokPreviewLines(rows, { indent = 4 } = {}) {
  const pad = " ".repeat(indent);
  return (rows || []).filter(Boolean).map((line) => `${pad}${typeof line === "string" && !line.includes("\x1b") ? muted(line) : line}`);
}

// ---------------------------------------------------------------------------
// 1. ASCII Art Logo with Gradient
// ---------------------------------------------------------------------------

export function asciiLogo({ width = 60 } = {}) {
  // Return array of lines for a sleek ASCII art logo of 'azycode'
  const top = "  ▄▀█ ▀█ █▄█ █▀▀ █▀█ █▀▄ █▀▀";
  const bot = "  █▀█ █▄ ░█░ █▄▄ █▄█ █▄▀ ██▄";
  
  // ponytail: reuse module-level detection (colorsEnabled gates on TTY/FORCE_COLOR/dumb too).
  const gradientCodes = trueColorEnabled
    ? [
        "\x1b[38;2;120;140;255m",   // brand blue/purple
        "\x1b[38;2;125;160;255m",
        "\x1b[38;2;130;190;255m",   // info blue
        "\x1b[38;2;120;200;240m",
        "\x1b[38;2;130;210;200m",
        "\x1b[38;2;180;210;140m",
        "\x1b[38;2;214;180;100m"    // accent gold
      ]
    : [
        ANSI.brand,
        ANSI.brand,
        ANSI.info,
        ANSI.info,
        ANSI.accent,
        ANSI.accent,
        ANSI.accent
      ];

  const applyGradient = (line) => {
    if (!colorsEnabled) return line;
    // Split into 7 letter blocks (each ~4 chars wide)
    const blocks = line.match(/.{1,4}/g) || [line];
    return blocks.map((block, i) => {
      const code = gradientCodes[Math.min(i, gradientCodes.length - 1)];
      return `${code}${block}${ANSI.reset}`;
    }).join("");
  };

  const pad = width > visibleLength(top) + 4 ? Math.floor((width - visibleLength(top)) / 2) : 2;
  const indent = " ".repeat(pad);
  return [
    `${indent}${applyGradient(top)}`,
    `${indent}${applyGradient(bot)}`
  ];
}

// ---------------------------------------------------------------------------
// 2. Enhanced Welcome Screen
// ---------------------------------------------------------------------------

const BUILT_IN_TIPS = [
  "Use Tab to cycle reasoning levels",
  "Shift+Tab to switch modes",
  "Type ! followed by a command for quick shell access",
  "/context to include repo context in your next prompt",
  "/compact to reduce conversation size when running low",
  "Use /mission dry-run to preview automation plans",
  "/login to connect your API key",
  "Press ↑ to recall your last prompt",
  "Chain commands with && in shell mode",
  "/status shows your current session stats",
  "Use /diff to see pending changes before applying",
  "Wrap code in backticks for inline formatting",
  "/help shows all available commands",
  "/clear resets the conversation context"
];

export function enhancedWelcomeScreen({
  connected = false,
  workspace = "workspace",
  branch = null,
  nodeVersion = typeof process !== "undefined" ? process.version : "",
  platform = typeof process !== "undefined" ? process.platform : "",
  terminalWidth = 80,
  sessionCount = 0,
  lastSession = null,
  model = null,
  mode = null,
  reasoning = null,
  tips = true,
  width = 80
} = {}) {
  const w = Math.max(48, width);
  const dot = style("●", connected ? "success" : "warn");
  const sep = style(" · ", "subtle");
  const lines = [];

  // Line 1: wordmark + version + connection state.
  const versionBit = faint("v0.1");
  const connBit = connected ? success("connected") : warn("offline");
  lines.push(`  ${bold(brand("azycode"))}  ${versionBit}  ${dot} ${connBit}`);

  // Line 2: context row — place · model · mode/reason. (platform dropped — it's
  // the kernel name like "darwin", not useful in the header.)
  const place = grokWorkspaceLabel(workspace, branch);
  const ctxParts = [place].filter(Boolean);
  if (model) ctxParts.push(accent(model));
  const modeReason = [mode, reasoning].filter(Boolean).join("/");
  if (modeReason) ctxParts.push(info(modeReason));
  if (ctxParts.length) lines.push(`  ${ctxParts.join(sep)}`);

  // Line 3: thin rule.
  lines.push(`  ${style("─".repeat(Math.max(8, w - 4)), "rule")}`);

  // Line 4: hint — resume the last session, or a tip, or a connect hint.
  const promptText = lastSession && typeof lastSession === "object"
    ? String(lastSession.prompt || lastSession.id || "")
    : "";
  if (promptText) {
    lines.push(`  ${style("↩", "info")} ${muted("resume")} ${sep} ${accent(truncate(promptText, Math.max(16, w - 24)))}`);
  } else if (!connected) {
    lines.push(`  ${muted("connect with")} ${accent("/login")} ${muted("to start")}`);
  } else if (tips && BUILT_IN_TIPS.length) {
    const tip = BUILT_IN_TIPS[Math.floor(Math.random() * BUILT_IN_TIPS.length)];
    lines.push(`  ${muted("tip:")} ${faint(truncate(tip, Math.max(16, w - 10)))}`);
  } else {
    lines.push(`  ${muted("describe a change, or")} ${accent("/help")} ${muted("for commands")}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 3. Tool Execution Card
// ---------------------------------------------------------------------------

const TOOL_GLYPHS = {
  read: { icon: "◇", style: "info" },
  write: { icon: "✎", style: "accent" },
  edit: { icon: "✎", style: "accent" },
  search: { icon: "⌕", style: "info" },
  shell: { icon: "⎕", style: "warn" },
  run: { icon: "▸", style: "success" },
  delete: { icon: "✗", style: "error" },
  create: { icon: "+", style: "success" },
  list: { icon: "◇", style: "muted" },
  patch: { icon: "✎", style: "accent" },
  default: { icon: "◆", style: "brand" }
};

function resolveToolGlyph(tool) {
  const lower = String(tool ?? "").toLowerCase();
  for (const key of Object.keys(TOOL_GLYPHS)) {
    if (key !== "default" && lower.includes(key)) return TOOL_GLYPHS[key];
  }
  return TOOL_GLYPHS.default;
}

export function toolCard({
  tool = "",
  status = "ok",
  duration = null,
  summary = "",
  preview = null,
  step = null,
  maxSteps = null,
  width = 80
} = {}) {
  const w = Math.max(40, width);
  const ok = status === "ok";
  const glyph = resolveToolGlyph(tool);
  const glyphStr = style(glyph.icon, ok ? glyph.style : "error");

  // Status glyph carries success/failure; the word only prints on failure.
  const statusGlyph = ok ? success("✓") : error("✗");
  const durStr = duration != null ? faint(prettyMs(duration)) : "";

  // Right side: duration · step · status glyph (+ failure word).
  const rightParts = [];
  if (step != null && maxSteps != null) rightParts.push(faint(`${step}/${maxSteps}`));
  if (durStr) rightParts.push(durStr);
  rightParts.push(statusGlyph);
  if (!ok) rightParts.push(error(typeof status === "string" && status !== "failed" ? status : "failed"));
  const right = rightParts.join(" ");

  // Left side: glyph + padded bold tool name + muted summary.
  const toolName = padEnd(bold(String(tool)), 10);
  const summaryStr = summary ? `  ${muted(truncate(String(summary), Math.max(8, w - 30)))}` : "";
  const left = `  ${glyphStr} ${toolName}${summaryStr}`;

  const gap = Math.max(2, w - visibleLength(left) - visibleLength(right));
  const lines = [`${left}${" ".repeat(gap)}${right}`];

  // Preview / diff lines
  if (preview) {
    const previewLines = Array.isArray(preview) ? preview : String(preview).split("\n");
    const pipe = `  ${style("│", "faint")} `;
    for (const line of previewLines.slice(0, 6)) {
      const text = String(line ?? "");
      let rendered;
      if (text.startsWith("+")) rendered = success(text);
      else if (text.startsWith("-")) rendered = error(text);
      else rendered = muted(text);
      lines.push(`${pipe}${truncate(rendered, Math.max(16, w - 6))}`);
    }
    if (previewLines.length > 6) {
      lines.push(`${pipe}${faint(`… ${previewLines.length - 6} more lines`)}`);
    }
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 4. Thinking Block
// ---------------------------------------------------------------------------

export function thinkingBlock({
  duration = null,
  tokens = null,
  model = null,
  width = 80
} = {}) {
  const sep = style(" · ", "subtle");
  const parts = [style("thought", "brand")];
  if (duration != null) parts.push(faint(prettyMs(duration)));
  if (tokens != null) {
    const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
    parts.push(faint(`${tok} tok`));
  }
  if (model) parts.push(faint(truncate(model, 20)));
  return [`  ${style(icon("sparkle"), "brand")} ${parts.join(sep)}`];
}

// ---------------------------------------------------------------------------
// 5. Cost & Usage Display — imported from src/ui/cost.js (see header).
//    MODEL_PRICING, estimateCost, formatTokenCount, formatUSD, costColor,
//    costDisplay, and costSummaryPanel all live in the cost layer.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 6. Enhanced Error Panel
// ---------------------------------------------------------------------------

export function errorPanel({
  title = "Error",
  message = "",
  code = null,
  suggestion = null,
  retryHint = null,
  context = null,
  width = 80
} = {}) {
  const rows = [];

  if (message) {
    for (const line of wrapText(String(message), Math.max(20, width - 8))) {
      rows.push(line);
    }
  }

  if (code != null) {
    rows.push(`${muted("code:")} ${style(String(code), "warn")}`);
  }

  if (context) {
    rows.push(muted(String(context)));
  }

  if (suggestion) {
    rows.push(`${style("Try:", "warn")} ${suggestion}`);
  }

  if (retryHint) {
    rows.push(`${style("↩", "info")} ${muted(retryHint)}`);
  }

  // Return { lines } so callers that destructure .lines get the styled box.
  return {
    lines: box(rows, {
      width,
      title: `${icon("cross")} ${title}`,
      titleTone: "error",
      frame: "rounded",
      color: "error",
      padding: 1
    })
  };
}

// ---------------------------------------------------------------------------
// 7. Session Card
// ---------------------------------------------------------------------------

export function sessionCard({
  id = "",
  mode = "",
  status = "",
  steps = 0,
  duration = "",
  prompt = "",
  cost = null,
  width = 60
} = {}) {
  const w = Math.max(40, width);
  const lines = [];
  const sep = style(" · ", "subtle");

  // Header: id  mode  ●status   right-aligned stats
  const idStr = faint(truncate(String(id || "—"), 12));
  const modeBit = mode ? ` ${chip(mode, "accent")}` : "";
  const dotBit = status ? ` ${statusDot(status)}` : "";
  const statParts = [];
  if (steps) statParts.push(faint(`${steps} step${steps === 1 ? "" : "s"}`));
  if (duration) statParts.push(faint(String(duration)));
  if (cost != null) statParts.push(style(formatUSD(cost), costColor(cost)));
  const stats = statParts.join(sep);
  const left = `  ${idStr}${modeBit}${dotBit}`;
  const gap = stats ? Math.max(2, w - visibleLength(left) - visibleLength(stats)) : 0;
  lines.push(stats ? `${left}${" ".repeat(gap)}${stats}` : left);

  // Prompt
  if (prompt) {
    const maxPrompt = Math.max(16, w - 6);
    lines.push(`    ${muted("›")} ${faint(truncate(String(prompt).trim(), maxPrompt))}`);
  }

  return lines;
}

// ---------------------------------------------------------------------------
// 8. File Tree View
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 9. Breadcrumb Trail
// ---------------------------------------------------------------------------

export function breadcrumb(items, { separator = " › ", width = 80 } = {}) {
  if (!items || !items.length) return "";
  const styles = ["brand", "info", "accent", "muted", "faint"];
  const parts = items.map((item, i) => {
    const label = typeof item === "string" ? item : item.label || "";
    const itemStyle = (typeof item === "object" && item.style) || styles[Math.min(i, styles.length - 1)];
    return style(label, itemStyle);
  });
  const sep = faint(separator);
  const result = parts.join(sep);
  return truncate(result, width);
}

// ---------------------------------------------------------------------------
// 10. Live Metrics Bar
// ---------------------------------------------------------------------------

export function liveMetricsBar({
  tokens = null,
  cost = null,
  elapsed = null,
  step = null,
  maxSteps = null,
  model = null,
  width = 80
} = {}) {
  const parts = [];
  parts.push(style("⟡", "glow"));

  if (tokens != null) parts.push(faint(`${formatTokenCount(tokens)} tok`));
  if (cost != null) parts.push(style(formatUSD(cost), costColor(cost)));
  if (elapsed != null) parts.push(faint(typeof elapsed === "number" ? prettyMs(elapsed) : String(elapsed)));
  if (step != null && maxSteps != null) parts.push(muted(`step ${step}/${maxSteps}`));
  else if (step != null) parts.push(muted(`step ${step}`));
  if (model) parts.push(faint(truncate(String(model), 24)));

  const line = parts.join(style(" · ", "subtle"));
  const w = Math.max(40, width);
  const gap = Math.max(0, w - visibleLength(line));
  return `${" ".repeat(gap)}${line}`;
}

// ---------------------------------------------------------------------------
// 11. Quick Tips Array
// ---------------------------------------------------------------------------

export function randomTip() {
  return BUILT_IN_TIPS[Math.floor(Math.random() * BUILT_IN_TIPS.length)];
}

// ---------------------------------------------------------------------------
// 12. Enhanced Diff Display
// ---------------------------------------------------------------------------

export function richDiffBlock(text, { maxLines = 8, width = 60, showLineNumbers = true, title = null } = {}) {
  const rawLines = String(text ?? "").split("\n").filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
  const lines = rawLines.slice(0, maxLines);
  if (!lines.length) return [];

  const out = [];
  const w = Math.max(30, width);

  // File header
  if (title) {
    out.push(`  ${style("─", "faint")} ${accent(title)} ${style("─".repeat(Math.max(2, w - visibleLength(title) - 6)), "faint")}`);
  }

  const gutterWidth = showLineNumbers ? String(lines.length).length + 1 : 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = showLineNumbers ? faint(padStart(String(i + 1), gutterWidth)) + " " : "";
    const pipe = `${style("│", "faint")} `;

    let rendered;
    if (line.startsWith("+")) {
      const bg = trueColorEnabled ? "\x1b[48;2;20;60;20m" : "";
      const fg = ANSI.success;
      rendered = colorsEnabled ? `${bg}${fg}${line}${ANSI.reset}` : line;
    } else if (line.startsWith("-")) {
      const bg = trueColorEnabled ? "\x1b[48;2;60;20;20m" : "";
      const fg = ANSI.error;
      rendered = colorsEnabled ? `${bg}${fg}${line}${ANSI.reset}` : line;
    } else {
      rendered = muted(line);
    }

    out.push(`  ${lineNo}${pipe}${truncate(rendered, Math.max(12, w - gutterWidth - 6))}`);
  }

  if (rawLines.length > maxLines) {
    const remaining = rawLines.length - maxLines;
    out.push(`  ${" ".repeat(gutterWidth)}${style("│", "faint")} ${faint(`… ${remaining} more line${remaining === 1 ? "" : "s"}`)}`);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 13. Notification Toast
// ---------------------------------------------------------------------------

const TOAST_CONFIG = {
  info:    { icon: "ℹ", style: "info" },
  success: { icon: "✓", style: "success" },
  warn:    { icon: "⚠", style: "warn" },
  error:   { icon: "✗", style: "error" },
  tip:     { icon: "💡", style: "accent" }
};

export function toastMessage(text, { type = "info", width = 60 } = {}) {
  const config = TOAST_CONFIG[type] || TOAST_CONFIG.info;
  const toastIcon = style(config.icon, config.style);
  const body = truncate(String(text ?? ""), Math.max(20, width - 4));
  return `${toastIcon} ${body}`;
}
