// Azycode UI primitives
// Dependency-free terminal rendering: colors, boxes, badges, tables, spinners, status pills.
// All helpers degrade to plain text when the terminal does not advertise color.

import { stdout, stderr, env } from "node:process";

// ---------------------------------------------------------------------------
// Color capability detection
// ---------------------------------------------------------------------------

const TERM = env.TERM || "";
const NO_COLOR = "NO_COLOR" in env;
const FORCE_COLOR = env.FORCE_COLOR;

function detectColor() {
  if (NO_COLOR) return false;
  if (FORCE_COLOR === "1" || FORCE_COLOR === "true") return true;
  if (FORCE_COLOR === "0" || FORCE_COLOR === "false") return false;
  if (TERM === "dumb") return false;
  if (stdout && stdout.isTTY) return true;
  return false;
}

const colorsEnabled = detectColor();
const trueColorEnabled = colorsEnabled && (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || /-256color/.test(TERM));

// 8-color fallback + 256-color palette for richer tones when supported.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  hidden: "\x1b[8m",
  strikethrough: "\x1b[9m",
  // 16-color foregrounds
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightBlack: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
  // 256-color helpers (semantic) — tuned for readable dark terminals
  muted: "\x1b[38;5;251m",
  subtle: "\x1b[38;5;249m",
  faint: "\x1b[38;5;244m",
  accent: "\x1b[38;5;214m",
  success: "\x1b[38;5;114m",
  warn: "\x1b[38;5;179m",
  error: "\x1b[38;5;203m",
  info: "\x1b[38;5;117m",
  brand: "\x1b[38;5;183m",
  panel: "\x1b[38;5;59m",
  border: "\x1b[38;5;60m",
  borderSoft: "\x1b[38;5;245m",
  glow: "\x1b[38;5;183m",
  rule: "\x1b[38;5;243m"
};

const namedColors = {
  bold: ANSI.bold,
  dim: ANSI.dim,
  italic: ANSI.italic,
  underline: ANSI.underline,
  strikethrough: ANSI.strikethrough,
  inverse: ANSI.inverse,
  hidden: ANSI.hidden,
  red: ANSI.red,
  green: ANSI.green,
  yellow: ANSI.yellow,
  blue: ANSI.blue,
  magenta: ANSI.magenta,
  cyan: ANSI.cyan,
  white: ANSI.white,
  brightRed: ANSI.brightRed,
  brightGreen: ANSI.brightGreen,
  brightYellow: ANSI.brightYellow,
  brightBlue: ANSI.brightBlue,
  brightMagenta: ANSI.brightMagenta,
  brightCyan: ANSI.brightCyan,
  brightWhite: ANSI.brightWhite,
  brightBlack: ANSI.brightBlack,
  muted: ANSI.muted,
  subtle: ANSI.subtle,
  faint: ANSI.faint,
  accent: ANSI.accent,
  success: ANSI.success,
  warn: ANSI.warn,
  error: ANSI.error,
  info: ANSI.info,
  brand: ANSI.brand,
  panel: ANSI.panel,
  border: ANSI.border,
  borderSoft: ANSI.borderSoft,
  glow: ANSI.glow,
  rule: ANSI.rule
};

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
// Style primitives
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


export function style(text, name) {
  if (!colorsEnabled) return String(text);
  const open = namedColors[name];
  if (!open) return String(text);
  return `${open}${text}${ANSI.reset}`;
}

export function paint(text, openCode) {
  if (!colorsEnabled) return String(text);
  if (!openCode) return String(text);
  return `${openCode}${text}${ANSI.reset}`;
}

// Shortcut semantic colors
export const muted = (text) => style(text, "muted");
export const subtle = (text) => style(text, "subtle");
export const faint = (text) => style(text, "faint");
export const accent = (text) => style(text, "accent");
export const success = (text) => style(text, "success");
export const warn = (text) => style(text, "warn");
export const error = (text) => style(text, "error");
export const info = (text) => style(text, "info");
export const brand = (text) => style(text, "brand");

export const dim = (text) => style(text, "dim");
export const bold = (text) => style(text, "bold");
export const cyan = (text) => style(text, "cyan");
export const green = (text) => style(text, "green");
export const yellow = (text) => style(text, "yellow");
export const red = (text) => style(text, "red");

// Width helpers (ignore ANSI escapes).
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

export function visibleLength(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").length;
}

export function padEnd(value, width, fill = " ") {
  const text = String(value ?? "");
  const gap = width - visibleLength(text);
  return gap > 0 ? text + fill.repeat(gap) : text;
}

export function padStart(value, width, fill = " ") {
  const text = String(value ?? "");
  const gap = width - visibleLength(text);
  return gap > 0 ? fill.repeat(gap) + text : text;
}

export function truncate(value, width, suffix = "…") {
  const text = String(value ?? "");
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const out = [];
  let len = 0;
  const target = Math.max(1, width - visibleLength(suffix));
  let inEscape = false;
  for (const ch of text) {
    if (inEscape) {
      out.push(ch);
      if (/[a-zA-Z]/.test(ch)) inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      out.push(ch);
      continue;
    }
    if (len >= target) break;
    out.push(ch);
    len += 1;
  }
  return `${out.join("")}${suffix}`;
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

export { stripAnsi };

function sliceVisible(text, maxVisible) {
  const out = [];
  let len = 0;
  let inEscape = false;
  for (const ch of String(text ?? "")) {
    if (inEscape) {
      out.push(ch);
      if (/[a-zA-Z]/.test(ch)) inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      out.push(ch);
      continue;
    }
    if (len >= maxVisible) break;
    out.push(ch);
    len += 1;
  }
  return out.join("");
}

function skipVisible(text, count) {
  let skipped = 0;
  let inEscape = false;
  let index = 0;
  const value = String(text ?? "");
  while (index < value.length && skipped < count) {
    const ch = value[index];
    if (inEscape) {
      index += 1;
      if (/[a-zA-Z]/.test(ch)) inEscape = false;
      continue;
    }
    if (ch === "\x1b") {
      inEscape = true;
      index += 1;
      continue;
    }
    skipped += 1;
    index += 1;
  }
  return value.slice(index);
}

export function wrapText(value, maxWidth) {
  const width = Math.max(1, Number(maxWidth) || 1);
  const text = String(value ?? "");
  if (!text) return [""];
  const lines = [];
  for (const paragraph of text.split("\n")) {
    let remaining = paragraph;
    if (!remaining) {
      lines.push("");
      continue;
    }
    while (visibleLength(remaining) > width) {
      const chunk = sliceVisible(remaining, width);
      const plain = stripAnsi(chunk);
      let breakAt = plain.length;
      const space = plain.lastIndexOf(" ");
      if (space > 0) breakAt = space;
      const head = sliceVisible(remaining, breakAt);
      lines.push(head.trimEnd());
      remaining = skipVisible(remaining, breakAt).trimStart();
      if (!remaining) break;
    }
    if (remaining) lines.push(remaining);
  }
  return lines.length ? lines : [""];
}

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

function modeColor(mode) {
  if (mode === "plan") return "info";
  if (mode === "build") return "success";
  if (mode === "always-approve") return "warn";
  if (mode === "goal") return "brand";
  if (mode === "review") return "accent";
  return "muted";
}

// ---------------------------------------------------------------------------
// Rules, frames, panels
// ---------------------------------------------------------------------------

const FRAME = {
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  thin: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" }
};

export function rule(width = 60, { char = "─", color = "rule", label = null, labelColor = "muted", align = "center" } = {}) {
  const w = Math.max(8, width);
  if (!label) {
    return style(char.repeat(w), color);
  }
  const text = ` ${label} `;
  const remaining = w - visibleLength(text);
  if (remaining < 4) return style(text.padEnd(w, char), color);
  let left;
  let right;
  if (align === "left") {
    left = 0;
    right = remaining;
  } else if (align === "right") {
    left = remaining;
    right = 0;
  } else {
    left = Math.floor(remaining / 2);
    right = remaining - left;
  }
  return `${style(char.repeat(left), color)}${style(text, labelColor)}${style(char.repeat(right), color)}`;
}

export function frame(styleName = "rounded") {
  return FRAME[styleName] || FRAME.rounded;
}

export function box(rows, {
  width,
  frame: frameName = "rounded",
  color = "border",
  title = null,
  titleTone = "brand",
  titleIcon = null,
  padding = 1,
  align = "left"
} = {}) {
  const f = frame(frameName);
  const w = Math.max(20, width || maxContentWidth(rows, padding));
  const inner = Math.max(1, w - 2 - padding * 2);
  const expanded = [];
  for (const row of rows) {
    expanded.push(...wrapText(String(row ?? ""), inner));
  }
  const lines = expanded.map((row) => renderBoxRow(row, w - 2, padding, align));
  const bottom = style(`${f.bl}${f.h.repeat(w - 2)}${f.br}`, color);
  const bordered = lines.map((line) => `${style(f.v, color)} ${line} ${style(f.v, color)}`);
  let top;
  if (title) {
    // ponytail: truncate the title so the top border never exceeds the box width.
    const titleText = truncate(title, Math.max(4, w - 4));
    const label = ` ${panelTitle(titleText, { tone: titleTone, icon: titleIcon })} `;
    const remaining = Math.max(0, w - 2 - visibleLength(label));
    const left = 1;
    const right = Math.max(0, remaining - left);
    top = `${style(f.tl, color)}${style(f.h.repeat(left), color)}${label}${style(f.h.repeat(right), color)}${style(f.tr, color)}`;
  } else {
    top = style(`${f.tl}${f.h.repeat(w - 2)}${f.tr}`, color);
  }
  return [top, ...bordered, bottom];
}

function renderBoxRow(row, innerWidth, padding, align) {
  const value = String(row ?? "");
  const padded = padding > 0 ? " ".repeat(padding) + value + " ".repeat(padding) : value;
  const totalWidth = innerWidth;
  const len = visibleLength(padded);
  if (len > totalWidth) return truncate(padded, totalWidth);
  if (align === "right") return " ".repeat(totalWidth - len) + padded;
  if (align === "center") {
    const left = Math.floor((totalWidth - len) / 2);
    return " ".repeat(left) + padded + " ".repeat(totalWidth - len - left);
  }
  return padded + " ".repeat(totalWidth - len);
}

function maxContentWidth(rows, padding) {
  const longest = rows.reduce((max, row) => Math.max(max, visibleLength(row)), 0);
  return Math.max(20, longest + padding * 2 + 2);
}

export function panel(title, rows, { width, color = "panel", frame: frameName = "rounded", padding = 1 } = {}) {
  if (!rows.length) {
    return box([title, muted("(empty)")], { width, frame: frameName, color, padding });
  }
  return box([title, ...rows], { width, frame: frameName, color, padding });
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
  const body = rows?.length ? rows : [muted(empty)];
  return box(body, { width, title, titleTone: "brand", frame: "rounded", color: "border", padding: 1 });
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
  const lines = [];

  lines.push(...asciiLogo({ width: w - 4 }));

  // Literal wordmark line so the welcome is identifiable as plain text
  // (the ASCII-art logo alone is not machine-readable as "azycode").
  lines.push(`  ${bold(brand("azycode"))}`);

  const dot = connected ? success("●") : warn("●");
  const connLabel = connected ? success("connected") : warn("offline");
  const place = grokWorkspaceLabel(workspace, branch);
  const nodeBit = nodeVersion ? faint(nodeVersion) : "";
  const platBit = platform ? faint(platform) : "";
  const statusParts = [`${dot} ${connLabel}`, place, nodeBit, platBit].filter(Boolean);
  
  lines.push(`  ${statusParts.join(style("  ·  ", "subtle"))}`);
  
  const modelBit = model ? `${muted("model:")} ${accent(model)}` : "";
  const modeBit = mode ? `${muted("mode:")} ${info(mode)}` : "";
  const reasoningBit = reasoning ? `${muted("reason:")} ${info(reasoning)}` : "";
  const stateParts = [modelBit, modeBit, reasoningBit].filter(Boolean);
  if (stateParts.length) {
    lines.push(`  ${stateParts.join(style("  ·  ", "subtle"))}`);
  }
  
  lines.push(`  ${style("─".repeat(Math.max(8, w - 6)), "rule")}`);

  // Combine actions into just 2 lines
  lines.push(`  ${padEnd(`${bold("Type")} ${muted("to chat")}`, 25)} ${padEnd(`${bold("/")} ${muted("commands")}`, 20)} ${bold("Tab")} ${muted("reasoning")}`);
  lines.push(`  ${padEnd(`${bold("!")} ${muted("shell")}`, 25)} ${padEnd(`${bold("/context")} ${muted("repo")}`, 20)} ${bold("Shift+Tab")} ${muted("mode")}`);

  lines.push(`  ${muted("What should we work on?")}  ${subtle("/help for commands")}`);

  if (lastSession) {
    lines.push(`  ${style("↩", "info")} ${muted("Resume:")} ${accent(truncate(String(lastSession), 30))}`);
  } else if (tips) {
    const tip = BUILT_IN_TIPS[Math.floor(Math.random() * BUILT_IN_TIPS.length)];
    lines.push(`  ${style("💡", "warn")} ${faint(`Tip: ${tip}`)}`);
  }

  lines.push("");

  // Wrap in rounded brand box
  return box(lines, { width: w, frame: "rounded", color: "border", padding: 0 });
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
  const glyph = resolveToolGlyph(tool);
  const glyphStr = style(glyph.icon, glyph.style);

  // Status indicator
  const statusIcon = status === "ok" ? success("✓") : status === "failed" ? error("✗") : warn("⚠");
  const statusLabel = status === "ok"
    ? success("ok")
    : status === "failed"
      ? error("failed")
      : warn(status);

  const durStr = duration != null ? faint(prettyMs(duration)) : "";
  const stepStr = step != null && maxSteps != null ? faint(`${step}/${maxSteps}`) : "";

  // Build right side
  const rightParts = [statusIcon, statusLabel, durStr, stepStr].filter(Boolean);
  const right = rightParts.join(" ");

  // Build left side
  const toolLabel = bold(String(tool));
  const summaryStr = summary ? `  ${muted(summary)}` : "";
  const left = `${glyphStr} ${toolLabel}${summaryStr}`;

  // Combine with padding
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
  const w = Math.max(30, width);
  const glowIcon = style("⟡", "glow");
  const label = style("Thinking", "glow");

  const metaParts = [];
  if (duration != null) metaParts.push(faint(prettyMs(duration)));
  if (tokens != null) {
    const tok = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
    metaParts.push(faint(`${tok} tok`));
  }
  if (model) metaParts.push(faint(truncate(model, 20)));
  const meta = metaParts.join(style(" · ", "subtle"));

  const leftStr = `  ${glowIcon} ${label} `;
  const rightStr = meta ? ` ${meta}` : "";
  const lineLen = Math.max(4, w - visibleLength(leftStr) - visibleLength(rightStr));
  const separator = style("─".repeat(lineLen), "faint");

  return [`${leftStr}${separator}${rightStr}`];
}

// ---------------------------------------------------------------------------
// 5. Cost & Usage Display
// ---------------------------------------------------------------------------

export const MODEL_PRICING = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4.1": { input: 2.0, output: 8.0 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4 },
  "o3": { input: 2.0, output: 8.0 },
  "o3-mini": { input: 1.1, output: 4.4 },
  "o4-mini": { input: 1.1, output: 4.4 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku": { input: 0.8, output: 4.0 },
  "claude-opus-4-20250514": { input: 15.0, output: 75.0 },
  "gemini-2.5-pro": { input: 1.25, output: 10.0 },
  "gemini-2.5-flash": { input: 0.15, output: 0.6 },
  "moonshot-v1": { input: 1.0, output: 2.0 },
  "kimi-latest": { input: 1.0, output: 2.0 },
  "deepseek-chat": { input: 0.14, output: 0.28 },
  "deepseek-reasoner": { input: 0.55, output: 2.19 }
};

export function estimateCost(model, inputTokens, outputTokens) {
  const modelName = String(model ?? "").toLowerCase();
  let pricing = MODEL_PRICING[modelName] || null;
  if (!pricing) {
    // Partial match: find the first key that the model name contains
    for (const key of Object.keys(MODEL_PRICING)) {
      if (modelName.includes(key) || key.includes(modelName)) {
        pricing = MODEL_PRICING[key];
        break;
      }
    }
  }
  if (!pricing) return null;
  const inTok = Math.max(0, Number(inputTokens) || 0);
  const outTok = Math.max(0, Number(outputTokens) || 0);
  const inputCost = (inTok / 1_000_000) * pricing.input;
  const outputCost = (outTok / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost };
}

function formatTokenCount(n) {
  const val = Number(n) || 0;
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

function formatUSD(amount) {
  const val = Math.max(0, Number(amount) || 0);
  if (val === 0) return "$0.00";
  if (val < 0.001) return `$${val.toFixed(6)}`;
  if (val < 0.01) return `$${val.toFixed(4)}`;
  if (val < 1) return `$${val.toFixed(3)}`;
  return `$${val.toFixed(2)}`;
}

function costColor(amount) {
  if (amount < 0.01) return "success";
  if (amount < 0.10) return "warn";
  return "error";
}

export function costDisplay({ model, inputTokens, outputTokens, sessionTotal = null, width = 60 } = {}) {
  const estimate = estimateCost(model, inputTokens, outputTokens);
  if (!estimate) return muted("(pricing unavailable)");

  const costStr = style(formatUSD(estimate.totalCost), costColor(estimate.totalCost));
  const inStr = faint(`in: ${formatTokenCount(inputTokens)}`);
  const outStr = faint(`out: ${formatTokenCount(outputTokens)}`);
  const parts = [`${costStr} ${muted("(")}${inStr}${muted(" · ")}${outStr}${muted(")")}`];

  if (sessionTotal != null) {
    parts.push(`${muted("session:")} ${style(formatUSD(sessionTotal), costColor(sessionTotal))}`);
  }

  return parts.join(style(" · ", "subtle"));
}

export function costSummaryPanel({ runs = [], sessionTotal = 0, width = 60 } = {}) {
  const rows = [];
  if (runs.length) {
    for (const [i, run] of runs.entries()) {
      const idx = faint(`#${i + 1}`);
      const modelLabel = run.model ? truncate(run.model, 20) : "unknown";
      const cost = run.cost != null ? style(formatUSD(run.cost), costColor(run.cost)) : muted("—");
      rows.push(`  ${idx}  ${padEnd(modelLabel, 22)} ${cost}`);
    }
    rows.push("");
  }
  const total = style(formatUSD(sessionTotal), costColor(sessionTotal));
  rows.push(`  ${bold("Session total:")} ${total}`);
  return box(rows, { width, title: "Cost Summary", titleTone: "accent", frame: "rounded", color: "borderSoft", padding: 1 });
}

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

  // Message
  if (message) {
    for (const line of wrapText(String(message), Math.max(20, width - 8))) {
      rows.push(line);
    }
  }

  // Code
  if (code != null) {
    rows.push("");
    rows.push(`${muted("code:")} ${style(String(code), "warn")}`);
  }

  // Context
  if (context) {
    rows.push(`${muted(String(context))}`);
  }

  // Suggestion
  if (suggestion) {
    rows.push("");
    rows.push(`${style("💡", "warn")} ${style("Try:", "warn")} ${suggestion}`);
  }

  // Retry hint
  if (retryHint) {
    rows.push(`${style("↩", "info")} ${muted(retryHint)}`);
  }

  return box(rows, {
    width,
    title: `${icon("cross")} ${title}`,
    titleTone: "error",
    frame: "rounded",
    color: "error",
    padding: 1
  });
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
  const rows = [];

  // Header line: id + mode badge + status dot
  const idStr = id ? faint(truncate(String(id), 10)) : faint("—");
  const modeBadge = mode ? chip(mode, "accent") : "";
  const statusDotStr = status ? ` ${statusDot(status)}` : "";
  rows.push(`${idStr}  ${modeBadge}${statusDotStr}`);

  // Stats line: steps, duration, cost
  const statParts = [];
  if (steps) statParts.push(muted(`${steps} step${steps === 1 ? "" : "s"}`));
  if (duration) statParts.push(muted(String(duration)));
  if (cost != null) statParts.push(style(formatUSD(cost), costColor(cost)));
  if (statParts.length) rows.push(`  ${statParts.join(style(" · ", "subtle"))}`);

  // Truncated prompt
  if (prompt) {
    const maxPrompt = Math.max(16, w - 8);
    rows.push(`  ${muted("›")} ${faint(truncate(String(prompt).trim(), maxPrompt))}`);
  }

  return box(rows, {
    width: w,
    title: "session",
    titleTone: "brand",
    frame: "rounded",
    color: "borderSoft",
    padding: 1
  });
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
