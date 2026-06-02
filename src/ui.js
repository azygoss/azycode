// Azycode UI primitives
// Dependency-free terminal rendering: colors, boxes, badges, tables, spinners, status pills.
// All helpers degrade to plain text when the terminal does not advertise color.

import { stdout, env } from "node:process";

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
  // 256-color helpers (semantic)
  muted: "\x1b[38;5;245m",
  subtle: "\x1b[38;5;240m",
  faint: "\x1b[38;5;238m",
  accent: "\x1b[38;5;215m",
  success: "\x1b[38;5;108m",
  warn: "\x1b[38;5;179m",
  error: "\x1b[38;5;167m",
  info: "\x1b[38;5;110m",
  brand: "\x1b[38;5;141m",
  panel: "\x1b[38;5;67m",
  rule: "\x1b[38;5;239m"
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
  rule: ANSI.rule
};

// ---------------------------------------------------------------------------
// Style primitives
// ---------------------------------------------------------------------------

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

export function clipText(value, max) {
  return truncate(value, max, "…");
}

function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

export { stripAnsi };

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
  prompt: "›"
};

export function icon(name) {
  return ICONS[name] ?? "";
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function spinnerFrame(index) {
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return SPINNER_FRAMES[((i % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length];
}

export function spinnerFrames() {
  return SPINNER_FRAMES.slice();
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

export function policyTag(mode) {
  if (mode === "auto") return style("auto", "success");
  if (mode === "ask") return style("ask", "warn");
  if (mode === "deny") return style("deny", "error");
  return style(String(mode ?? "—"), "muted");
}

export function pill(text, color = "muted") {
  return style(` ${text} `, color);
}

export function tag(text, color = "muted") {
  return style(text, color);
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------

export function statusBar(segments) {
  return segments
    .filter((segment) => segment !== null && segment !== undefined)
    .map((segment) => {
      if (typeof segment === "string") return segment;
      if (segment.style) return style(segment.text, segment.style);
      if (segment.color) return style(segment.text, segment.color);
      return segment.text;
    })
    .join(style(" │ ", "subtle"));
}

export function promptStatus({ mode, reasoning, agent = null, profile = null, guard = "ok" }) {
  const parts = [];
  parts.push(mode ? style(mode, modeColor(mode)) : style("—", "muted"));
  parts.push(reasoning ? style(reasoning, "info") : style("—", "muted"));
  if (agent) parts.push(style(`@${agent}`, "brand"));
  if (profile && profile !== "normal") parts.push(style(profile, "accent"));
  if (guard && guard !== "ok") parts.push(style(guard, guard === "blocked" ? "error" : "warn"));
  return parts.join(style(" │ ", "subtle"));
}

function modeColor(mode) {
  if (mode === "plan") return "info";
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

export function box(rows, { width, frame: frameName = "rounded", color = "panel", title = null, padding = 1, align = "left" } = {}) {
  const f = frame(frameName);
  const w = Math.max(20, width || maxContentWidth(rows, padding));
  const lines = rows.map((row) => renderBoxRow(row, w - 2, padding, align));
  const top = f.tl + f.h.repeat(w - 2) + f.tr;
  const bottom = f.bl + f.h.repeat(w - 2) + f.br;
  const bordered = lines.map((line) => `${style(f.v, color)} ${line} ${style(f.v, color)}`);
  if (title) {
    const label = ` ${title} `;
    const remaining = w - 2 - visibleLength(label) - 2;
    if (remaining > 0) {
      const left = 1;
      const right = Math.max(0, remaining - left);
      bordered[0] = `${style(f.v, color)} ${style(f.tl + f.h.repeat(left) + label + f.h.repeat(right) + f.tr, color)}`;
    }
  }
  return [style(top, color), ...bordered, style(bottom, color)];
}

function renderBoxRow(row, innerWidth, padding, align) {
  const value = String(row ?? "");
  const padded = padding > 0 ? " ".repeat(padding) + value + " ".repeat(padding) : value;
  const totalWidth = innerWidth;
  const len = visibleLength(padded);
  if (len >= totalWidth) return truncate(padded, totalWidth);
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

export function table(rows, columns) {
  if (!rows.length) return;
  const widths = columns.map((column) => {
    const cells = rows.map((row) => visibleLength(String(row[column.key] ?? "")));
    return Math.max(column.label.length, ...cells);
  });
  console.log(columns.map((column, index) => {
    const label = index === columns.length - 1 ? column.label : padEnd(column.label, widths[index]);
    return style(label, "dim");
  }).join("  "));
  for (const row of rows) {
    console.log(columns.map((column, index) => {
      const cell = String(row[column.key] ?? "");
      return index === columns.length - 1 ? cell : padEnd(cell, widths[index]);
    }).join("  "));
  }
}

// ---------------------------------------------------------------------------
// New richer table renderer
// ---------------------------------------------------------------------------

export function renderTable(rows, columns, options = {}) {
  const { header = true, border = true, headerColor = "muted", zebra = false } = options;
  if (!rows.length && !header) return [];
  const widths = columns.map((column) => {
    const cells = rows.map((row) => visibleLength(String(row[column.key] ?? "")));
    const headerLen = column.label ? visibleLength(column.label) : 0;
    return Math.max(headerLen, ...cells, column.minWidth || 0);
  });
  const sep = "  ";
  const out = [];
  if (header) {
    const headerRow = columns.map((column, index) => style(padEnd(column.label || "", widths[index]), headerColor)).join(sep);
    out.push(headerRow);
    if (border) {
      out.push(style(columns.map((column, index) => "─".repeat(widths[index])).join(sep), "rule"));
    }
  }
  rows.forEach((row, rowIndex) => {
    const isZebra = zebra && rowIndex % 2 === 1;
    out.push(columns.map((column, index) => {
      const cell = String(row[column.key] ?? "");
      const rendered = index === columns.length - 1 ? cell : padEnd(cell, widths[index]);
      return isZebra ? dim(rendered) : rendered;
    }).join(sep));
  });
  return out;
}

export function printTable(rows, columns, options = {}) {
  for (const line of renderTable(rows, columns, options)) console.log(line);
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

// ---------------------------------------------------------------------------
// Spinner runtime (used by TUI for "working..." state)
// ---------------------------------------------------------------------------

let activeSpinner = null;
let activeTimer = null;
let activeStart = 0;

export function startSpinner({ label = "working", stream = stdout, isTTY = stream?.isTTY, interval = 80 } = {}) {
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
    stream.write(`\r${" ".repeat(80)}\r${text}`);
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
    activeSpinner.stream.write(`\r${" ".repeat(80)}\r`);
  }
  if (finalLabel) {
    const symbol = finalStyle === "error" ? style("✗", "error") : style("✓", "success");
    const text = `${symbol} ${finalLabel} ${muted(elapsed)}`;
    console.log(text);
  }
  activeSpinner = null;
  activeStart = 0;
}

export function isSpinnerActive() {
  return Boolean(activeSpinner);
}

// ---------------------------------------------------------------------------
// Indented block (multiline content with hanging indent)
// ---------------------------------------------------------------------------

export function indentBlock(text, spaces = 2) {
  const pad = " ".repeat(spaces);
  return String(text ?? "").split("\n").map((line) => `${pad}${line}`).join("\n");
}

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
