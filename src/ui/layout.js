// src/ui/layout.js
// Layout primitives: horizontal rules, box-drawing frames, and panels.
// Depends only on the ansi layer (src/ui/ansi.js) for styling + width math.
// Higher-level components (ui.js) compose these into richer panels.

import {
  style,
  muted,
  visibleLength,
  truncate,
  wrapText
} from "./ansi.js";

/** Map a runtime mode name to a semantic color used across the UI. */
export function modeColor(mode) {
  if (mode === "plan") return "info";
  if (mode === "build") return "success";
  if (mode === "always-approve") return "warn";
  if (mode === "goal") return "brand";
  if (mode === "review") return "accent";
  return "muted";
}

// Box-drawing character sets selectable via the `frame` option.
export const FRAME = {
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
  thin: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  rounded: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  double: { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║" },
  heavy: { tl: "┏", tr: "┓", bl: "┗", br: "┛", h: "━", v: "┃" }
};

/**
 * Render a horizontal rule, optionally with a centered/left/right label.
 * @param {number} [width=60]
 * @param {object} [opts]
 * @param {string} [opts.char="─"]
 * @param {string} [opts.color="rule"]
 * @param {string|null} [opts.label]
 * @param {string} [opts.labelColor="muted"]
 * @param {"center"|"left"|"right"} [opts.align="center"]
 * @returns {string}
 */
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

/** Resolve a frame character set by name (defaults to "rounded"). */
export function frame(styleName = "rounded") {
  return FRAME[styleName] || FRAME.rounded;
}

/**
 * Pad/align a single row to `innerWidth` visible columns.
 * @private
 */
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

/** Compute the minimum content width needed to fit the longest row + padding. */
function maxContentWidth(rows, padding) {
  const longest = rows.reduce((max, row) => Math.max(max, visibleLength(row)), 0);
  return Math.max(20, longest + padding * 2 + 2);
}

/**
 * Render a bordered box around `rows`. The optional `titleRenderer` lets the
 * caller supply a higher-level title formatter (e.g. an icon + tone chip from
 * ui.js) without creating a circular dependency on the components layer.
 * @param {string[]} rows
 * @param {object} [opts]
 * @returns {string[]} The rendered box lines (top border, rows, bottom border).
 */
export function box(rows, {
  width,
  frame: frameName = "rounded",
  color = "border",
  title = null,
  titleTone = "brand",
  titleIcon = null,
  padding = 1,
  align = "left",
  titleRenderer = null
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
    const titleText = truncate(title, Math.max(4, w - 4));
    const label = titleRenderer
      ? titleRenderer(titleText, { tone: titleTone, icon: titleIcon })
      : ` ${titleText} `;
    const remaining = Math.max(0, w - 2 - visibleLength(label));
    const left = 1;
    const right = Math.max(0, remaining - left);
    top = `${style(f.tl, color)}${style(f.h.repeat(left), color)}${label}${style(f.h.repeat(right), color)}${style(f.tr, color)}`;
  } else {
    top = style(`${f.tl}${f.h.repeat(w - 2)}${f.tr}`, color);
  }
  return [top, ...bordered, bottom];
}

/**
 * Render a titled panel. A thin wrapper around {@link box} that shows an
 * "(empty)" placeholder when there are no rows.
 */
export function panel(title, rows, { width, color = "panel", frame: frameName = "rounded", padding = 1 } = {}) {
  if (!rows.length) {
    return box([title, muted("(empty)")], { width, frame: frameName, color, padding });
  }
  return box([title, ...rows], { width, frame: frameName, color, padding });
}
