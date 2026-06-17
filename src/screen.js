import { cursorTo } from "node:readline";
import { stdout as defaultOutput } from "node:process";
import { visibleLength } from "./ui.js";

export function terminalRows(stream = defaultOutput) {
  return Math.max(12, Number(stream.rows) || 24);
}

export function terminalCols(stream = defaultOutput) {
  return Math.max(40, Number(stream.columns) || 80);
}

export function fitTerminalWidth(stream = defaultOutput, padding = 2) {
  return Math.max(40, terminalCols(stream) - padding);
}

export function setScrollRegion(top, bottom, stream = defaultOutput) {
  if (bottom <= top) return;
  stream.write(`\x1b[${top};${bottom}r`);
}

export function resetScrollRegion(stream = defaultOutput) {
  stream.write("\x1b[r");
}

export function applyScrollRegion(layout, stream = defaultOutput) {
  if (!layout) return;
  setScrollRegion(1, layout.startRow, stream);
}

export function clearLineAt(row, stream = defaultOutput) {
  cursorTo(stream, 0, row);
  stream.write("\x1b[2K");
}

export function writeAtRow(row, text, stream = defaultOutput) {
  cursorTo(stream, 0, row);
  stream.write("\x1b[2K");
  if (text) stream.write(text);
}

export function writeInBottomPane(layout, rowOffset, text, stream = defaultOutput) {
  if (!layout) return;
  resetScrollRegion(stream);
  writeAtRow(layout.startRow + rowOffset, text, stream);
  applyScrollRegion(layout, stream);
}

export function maxBottomPaneRows(stream = defaultOutput) {
  const total = terminalRows(stream);
  // Reserve a small fixed band for the top pane (welcome screen + prompt).
  const minScroll = Math.max(3, Math.min(5, total - 5));
  return Math.max(4, total - minScroll);
}

export function reserveBottomPane(rows, stream = defaultOutput) {
  const total = terminalRows(stream);
  const bottomRows = Math.min(Math.max(1, rows), maxBottomPaneRows(stream));
  const startRow = total - bottomRows;
  const layout = { startRow, bottomRows, scrollEnd: startRow, total };
  setScrollRegion(1, startRow, stream);
  return layout;
}

export function resizeBottomPane(layout, rows, stream = defaultOutput) {
  const total = terminalRows(stream);
  const bottomRows = Math.min(Math.max(1, rows), maxBottomPaneRows(stream));
  const startRow = total - bottomRows;
  if (layout?.bottomRows === bottomRows && layout?.startRow === startRow) return layout;
  resetScrollRegion(stream);
  if (layout) {
    for (let i = 0; i < layout.bottomRows; i++) {
      clearLineAt(layout.startRow + i, stream);
    }
  }
  const next = { startRow, bottomRows, scrollEnd: startRow, total };
  setScrollRegion(1, startRow, stream);
  return next;
}

export function clearBottomPane(layout, stream = defaultOutput) {
  if (!layout) return;
  resetScrollRegion(stream);
  for (let i = 0; i < layout.bottomRows; i++) {
    clearLineAt(layout.startRow + i, stream);
  }
  applyScrollRegion(layout, stream);
}

export function releaseBottomPane(layout, stream = defaultOutput) {
  resetScrollRegion(stream);
  if (!layout) return;
  for (let i = 0; i < layout.bottomRows; i++) {
    clearLineAt(layout.startRow + i, stream);
  }
  prepareTranscriptOutput(stream, layout);
}

export function prepareTranscriptOutput(stream = defaultOutput, layout = null) {
  resetScrollRegion(stream);
  if (stream.isTTY) stream.write("\x1b[?25h");
  if (!layout) return;
  const anchorRow = Math.max(0, layout.scrollEnd - 1);
  cursorTo(stream, 0, anchorRow);
  stream.write("\n");
}

export function placeCursorInPane({ layout, rowOffset, column, stream = defaultOutput }) {
  if (!layout) return;
  resetScrollRegion(stream);
  applyScrollRegion(layout, stream);
  cursorTo(stream, column, layout.startRow + rowOffset);
}

export function longestCommonPrefix(values) {
  if (!values.length) return "";
  let prefix = values[0];
  for (let i = 1; i < values.length; i++) {
    const value = values[i];
    let j = 0;
    while (j < prefix.length && j < value.length && prefix[j] === value[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

export function applyLineCompletion(line, cursor, hits) {
  if (!hits.length) return { line, cursor };
  const shared = longestCommonPrefix(hits);
  if (shared.length > line.length) {
    return { line: shared, cursor: shared.length };
  }
  if (hits.length === 1 && hits[0].length > line.length) {
    return { line: hits[0], cursor: hits[0].length };
  }
  return { line, cursor };
}

export function insertChar(line, cursor, ch) {
  const next = line.slice(0, cursor) + ch + line.slice(cursor);
  return { line: next, cursor: cursor + 1 };
}

export function deleteCharBefore(line, cursor) {
  if (cursor <= 0) return { line, cursor };
  return { line: line.slice(0, cursor - 1) + line.slice(cursor), cursor: cursor - 1 };
}

export function deleteCharAfter(line, cursor) {
  if (cursor >= line.length) return { line, cursor };
  return { line: line.slice(0, cursor) + line.slice(cursor + 1), cursor };
}

