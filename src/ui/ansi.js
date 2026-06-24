// src/ui/ansi.js
// Foundational ANSI styling + visible-width helpers.
// This is the lowest layer of the UI stack: color capability detection, the
// escape-code palette, semantic style shortcuts, and width calculations that
// correctly ignore ANSI escape sequences. Higher layers (layout.js, ui.js)
// build on these primitives.

import { stdout, env } from "node:process";

// ---------------------------------------------------------------------------
// Color capability detection
// ---------------------------------------------------------------------------

const TERM = env.TERM || "";
const NO_COLOR = "NO_COLOR" in env;
const FORCE_COLOR = env.FORCE_COLOR;

/** Detect whether the active terminal advertises color support. */
export function detectColor() {
  if (NO_COLOR) return false;
  if (FORCE_COLOR === "1" || FORCE_COLOR === "true") return true;
  if (FORCE_COLOR === "0" || FORCE_COLOR === "false") return false;
  if (TERM === "dumb") return false;
  if (stdout && stdout.isTTY) return true;
  return false;
}

/** True when color output is enabled (NO_COLOR aware, FORCE_COLOR honored). */
export const colorsEnabled = detectColor();
/** True when the terminal supports 24-bit / 256-color (truecolor) output. */
export const trueColorEnabled = colorsEnabled && (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || /-256color/.test(TERM));

// 8-color fallback + 256-color palette for richer tones when supported.
export const ANSI = {
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

/** Map of semantic color names -> ANSI open escape sequences. */
export const namedColors = {
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

// ---------------------------------------------------------------------------
// Style primitives
// ---------------------------------------------------------------------------

/**
 * Apply a named semantic style to text. Returns plain text when colors are
 * disabled, or when the name is unknown.
 * @param {string} text - The text to style.
 * @param {string} name - A key from {@link namedColors}.
 * @returns {string}
 */
export function style(text, name) {
  if (!colorsEnabled) return String(text);
  const open = namedColors[name];
  if (!open) return String(text);
  return `${open}${text}${ANSI.reset}`;
}

/**
 * Wrap text in an arbitrary ANSI open code (then reset). No-op when colors are
 * disabled or the open code is empty.
 * @param {string} text - The text to paint.
 * @param {string} openCode - A raw ANSI open escape sequence.
 * @returns {string}
 */
export function paint(text, openCode) {
  if (!colorsEnabled) return String(text);
  if (!openCode) return String(text);
  return `${openCode}${text}${ANSI.reset}`;
}

// Shortcut semantic colors.
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

// ---------------------------------------------------------------------------
// Width helpers (ignore ANSI escapes)
// ---------------------------------------------------------------------------

/** Regex matching SGR ("m") ANSI escape sequences for width math. */
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;

/**
 * Return the visible length of a string, excluding ANSI escape sequences.
 * Handles null/undefined safely.
 * @param {string} value
 * @returns {number}
 */
export function visibleLength(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "").length;
}

/** Right-pad `value` with `fill` to `width` visible columns. */
export function padEnd(value, width, fill = " ") {
  const text = String(value ?? "");
  const gap = width - visibleLength(text);
  return gap > 0 ? text + fill.repeat(gap) : text;
}

/** Left-pad `value` with `fill` to `width` visible columns. */
export function padStart(value, width, fill = " ") {
  const text = String(value ?? "");
  const gap = width - visibleLength(text);
  return gap > 0 ? fill.repeat(gap) + text : text;
}

/**
 * Truncate `value` to `width` visible columns, appending `suffix` (default
 * ellipsis) when truncation occurs. ANSI escape sequences are preserved and do
 * not count toward the width budget, so styled text truncates correctly.
 * @param {string} value
 * @param {number} width
 * @param {string} [suffix="…"]
 * @returns {string}
 */
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

/** Remove all ANSI escape sequences from `value`. */
export function stripAnsi(value) {
  return String(value ?? "").replace(ANSI_PATTERN, "");
}

/** Take up to `maxVisible` visible characters from `text`, preserving escapes. */
export function sliceVisible(text, maxVisible) {
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

/** Skip `count` visible characters from `text`, preserving escapes. */
export function skipVisible(text, count) {
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

/**
 * Word-wrap `value` to `maxWidth` visible columns. Existing newlines start a
 * new line; long runs are broken at word boundaries when possible. ANSI escape
 * sequences are preserved across the wrapped lines. Returns an array of lines.
 * @param {string} value
 * @param {number} maxWidth
 * @returns {string[]}
 */
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
