import { emitKeypressEvents } from "node:readline";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { normalizeTabKey } from "./terminal-input.js";
import {
  applyLineCompletion,
  deleteCharAfter,
  deleteCharBefore,
  insertChar,
  maxBottomPaneRows,
  placeCursorInPane,
  releaseBottomPane,
  reserveBottomPane,
  resizeBottomPane
} from "./screen.js";

export async function readComposerLine({
  input = defaultInput,
  output = defaultOutput,
  renderPane,
  getPaletteItems,
  resolveSlashSubmit,
  onShortcut,
  onClearScreen,
  completeLine,
  readlineInterface = null,
  initialRows = 8,
  history = [],
  onHistoryPush = null
} = {}) {
  return new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let paletteSelection = 0;
    let lastPaletteKey = null;
    let layout = reserveBottomPane(initialRows, output);
    let rawModeEnabled = false;
    let historyIndex = -1;
    let savedLine = "";

    const beginInput = () => {
      readlineInterface?.pause?.();
      if (input.isTTY && typeof input.setRawMode === "function") {
        input.setRawMode(true);
        rawModeEnabled = true;
      }
      input.resume?.();
      input.setEncoding?.("utf8");
    };

    const endInput = () => {
      if (rawModeEnabled && typeof input.setRawMode === "function") {
        input.setRawMode(false);
        rawModeEnabled = false;
      }
    };

    const paletteItems = () => (typeof getPaletteItems === "function" ? getPaletteItems(line) : []);

    const syncPaletteSelection = () => {
      const key = line.startsWith("/") ? line.slice(1).trim() : null;
      if (key !== lastPaletteKey) {
        paletteSelection = 0;
        lastPaletteKey = key;
      }
      const items = paletteItems();
      if (paletteSelection >= items.length) paletteSelection = Math.max(0, items.length - 1);
    };

    const repaint = () => {
      syncPaletteSelection();
      const cap = maxBottomPaneRows(output);
      let needed = Math.min(renderPane({ line, cursor, layout, paletteSelection }), cap);
      if (needed !== layout.bottomRows) {
        layout = resizeBottomPane(layout, needed, output);
        needed = Math.min(renderPane({ line, cursor, layout, paletteSelection }), layout.bottomRows);
      }
      const promptOffset = Math.min(
        layout.bottomRows - 1,
        renderPane.promptOffset ?? needed - 1
      );
      const promptCol = renderPane.promptColumn?.({ line, cursor }) ?? 0;
      placeCursorInPane({ layout, rowOffset: promptOffset, column: promptCol, stream: output });
    };

    const finish = (value) => {
      input.off("keypress", onKeypress);
      output.off?.("resize", onResize);
      releaseBottomPane(layout, output);
      endInput();
      resolve(value);
    };

    const fillPaletteSelection = () => {
      const items = paletteItems();
      const picked = items[paletteSelection]?.[0];
      if (!picked) return false;
      line = picked;
      cursor = line.length;
      return true;
    };

    const onResize = () => repaint();

    const onKeypress = (ch, key) => {
      key = normalizeTabKey(key);
      if (!key) {
        if (ch && ch >= " " && ch !== "\u007f") {
          ({ line, cursor } = insertChar(line, cursor, ch));
          repaint();
        }
        return;
      }

      if (key.name === "return") {
        if (key.shift) {
          ({ line, cursor } = insertChar(line, cursor, "\n"));
          repaint();
          return;
        }
        if (line.startsWith("/") && typeof resolveSlashSubmit === "function") {
          finish(resolveSlashSubmit(line, paletteItems(), paletteSelection));
          return;
        }
        if (line.trim() && typeof onHistoryPush === "function") {
          onHistoryPush(line.trim());
        }
        finish(line);
        return;
      }

      if (key.ctrl && key.name === "d") {
        ({ line, cursor } = insertChar(line, cursor, "\n"));
        repaint();
        return;
      }

      if (key.name === "escape") {
        if (line.startsWith("/")) {
          line = "";
          cursor = 0;
          paletteSelection = 0;
          lastPaletteKey = null;
          repaint();
          return;
        }
        finish("");
        return;
      }

      if (key.ctrl && key.name === "c") {
        finish("");
        return;
      }

      if (key.ctrl && key.name === "u") {
        line = "";
        cursor = 0;
        paletteSelection = 0;
        repaint();
        return;
      }

      if (key.ctrl && key.name === "l") {
        onClearScreen?.();
        repaint();
        return;
      }

      // History navigation (only when NOT in slash command mode)
      if (!line.startsWith("/") && (key.name === "up" || key.name === "down")) {
        if (history.length) {
          if (key.name === "up") {
            if (historyIndex === -1) {
              savedLine = line;
              historyIndex = history.length - 1;
            } else if (historyIndex > 0) {
              historyIndex -= 1;
            }
            line = history[historyIndex] || "";
            cursor = line.length;
            repaint();
            return;
          }
          if (key.name === "down") {
            if (historyIndex === -1) return;
            if (historyIndex < history.length - 1) {
              historyIndex += 1;
              line = history[historyIndex] || "";
            } else {
              historyIndex = -1;
              line = savedLine;
            }
            cursor = line.length;
            repaint();
            return;
          }
        }
      }

      if (line.startsWith("/") && (key.name === "up" || key.name === "down")) {
        const items = paletteItems();
        if (items.length) {
          paletteSelection = key.name === "up"
            ? Math.max(0, paletteSelection - 1)
            : Math.min(items.length - 1, paletteSelection + 1);
          repaint();
        }
        return;
      }

      if (key.name === "tab") {
        if (line.startsWith("/")) {
          const before = line;
          if (typeof completeLine === "function") {
            const [hits] = completeLine(line);
            ({ line, cursor } = applyLineCompletion(line, cursor, hits));
          }
          if (line === before && fillPaletteSelection()) {
            repaint();
            return;
          }
          repaint();
          return;
        }
        onShortcut?.(key);
        repaint();
        return;
      }

      if (line.startsWith("/") && key.name === "right" && cursor === line.length) {
        if (fillPaletteSelection()) {
          repaint();
          return;
        }
      }

      if (key.name === "backspace") {
        ({ line, cursor } = deleteCharBefore(line, cursor));
        repaint();
        return;
      }

      if (key.name === "delete") {
        ({ line, cursor } = deleteCharAfter(line, cursor));
        repaint();
        return;
      }

      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        repaint();
        return;
      }

      if (key.name === "right") {
        cursor = Math.min(line.length, cursor + 1);
        repaint();
        return;
      }

      if (key.name === "home") {
        cursor = 0;
        repaint();
        return;
      }

      if (key.name === "end") {
        cursor = line.length;
        repaint();
        return;
      }

      if (ch && !key.ctrl && !key.meta && ch >= " " && ch !== "\u007f") {
        ({ line, cursor } = insertChar(line, cursor, ch));
        repaint();
      }
    };

    beginInput();
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    output.on?.("resize", onResize);
    repaint();
  });
}

export async function readMultilinePrompt({
  input = defaultInput,
  output = defaultOutput,
  banner = "",
  prompt = "> ",
  continuation = "  ",
  onShortcut = null,
  onExit = null
} = {}) {
  return new Promise((resolve) => {
    let line = "";
    let cursor = 0;
    let submitted = false;

    const paint = () => {
      const rows = line.split("\n");
      output.write("\r\x1b[K");
      for (let i = 1; i < rows.length; i += 1) {
        output.write(`\x1b[1A\r\x1b[K`);
      }
      rows.forEach((row, index) => {
        output.write(`${index === 0 ? prompt : continuation}${row}\n`);
      });
      const active = rows.length - 1;
      const prefix = active === 0 ? prompt : continuation;
      const rowOffset = rows.length - active - 1;
      if (rowOffset) output.write(`\x1b[${rowOffset}A`);
      output.write(`\r\x1b[${prefix.length + cursor}C`);
    };

    const finish = (value) => {
      if (submitted) return;
      submitted = true;
      input.off("keypress", onKeypress);
      output.off?.("resize", onResize);
      if (typeof input.setRawMode === "function") input.setRawMode(false);
      output.write("\n");
      resolve(value);
    };

    const onResize = () => paint();

    const onKeypress = (ch, key) => {
      key = normalizeTabKey(key);
      if (!key) {
        if (ch && ch >= " " && ch !== "\u007f") {
          ({ line, cursor } = insertChar(line, cursor, ch));
          paint();
        }
        return;
      }

      if (key.name === "return") {
        if (key.shift) {
          ({ line, cursor } = insertChar(line, cursor, "\n"));
          paint();
          return;
        }
        finish(line.trim());
        return;
      }

      if (key.ctrl && key.name === "d") {
        ({ line, cursor } = insertChar(line, cursor, "\n"));
        paint();
        return;
      }

      if (key.ctrl && key.name === "c") {
        if (typeof onExit === "function") onExit();
        else process.exit(130);
        finish("");
        return;
      }

      if (key.name === "tab") {
        onShortcut?.(key);
        paint();
        return;
      }

      if (key.name === "backspace") {
        ({ line, cursor } = deleteCharBefore(line, cursor));
        paint();
        return;
      }

      if (key.name === "delete") {
        ({ line, cursor } = deleteCharAfter(line, cursor));
        paint();
        return;
      }

      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        paint();
        return;
      }

      if (key.name === "right") {
        cursor = Math.min(line.length, cursor + 1);
        paint();
        return;
      }

      if (key.name === "home") {
        const rowStart = line.lastIndexOf("\n", cursor - 1) + 1;
        cursor = rowStart;
        paint();
        return;
      }

      if (key.name === "end") {
        const rowEnd = line.indexOf("\n", cursor);
        cursor = rowEnd === -1 ? line.length : rowEnd;
        paint();
        return;
      }

      if (ch && !key.ctrl && !key.meta && ch >= " " && ch !== "\u007f") {
        ({ line, cursor } = insertChar(line, cursor, ch));
        paint();
      }
    };

    if (banner) output.write(`${banner}\n`);
    output.write(prompt);
    if (typeof input.setRawMode === "function") input.setRawMode(true);
    input.resume?.();
    input.setEncoding?.("utf8");
    emitKeypressEvents(input);
    input.on("keypress", onKeypress);
    output.on?.("resize", onResize);
  });
}