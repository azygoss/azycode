import { clearLine, cursorTo } from "node:readline";
import { stdout as defaultOutput } from "node:process";
import { visibleLength } from "./ui.js";

export function findUnderlyingInterface(rl) {
  if (!rl) return null;
  if (typeof rl._ttyWrite === "function") return rl;
  for (const sym of Object.getOwnPropertySymbols(rl)) {
    let val;
    try { val = rl[sym]; } catch { continue; }
    if (val && typeof val._ttyWrite === "function") return val;
  }
  return null;
}

export function normalizeTabKey(key) {
  if (!key) return key;
  if (key.name === "backtab") return { ...key, name: "tab", shift: true };
  return key;
}

export function createPromptSession({ output = defaultOutput, getPrompt }) {
  const streamFor = (rl) => rl?.output ?? output;
  const isTty = (rl) => Boolean(streamFor(rl)?.isTTY);

  function syncReadlinePrompt(rl) {
    const prompt = getPrompt();
    if (typeof rl?._prompt === "string") rl._prompt = prompt;
    for (const sym of Object.getOwnPropertySymbols(rl || {})) {
      if (String(sym).includes("_prompt")) {
        try { rl[sym] = prompt; } catch { /* ignore */ }
      }
    }
    return prompt;
  }

  function paintPromptLine(rl) {
    const stream = streamFor(rl);
    if (!stream?.isTTY) return;
    const line = rl?.line || "";
    const cursor = rl?.cursor ?? line.length;
    const prompt = syncReadlinePrompt(rl);
    clearLine(stream, 0);
    cursorTo(stream, 0);
    stream.write(prompt);
    stream.write(line);
    cursorTo(stream, visibleLength(prompt) + cursor);
  }

  function refreshPrompt(rl) {
    if (!rl) return;
    syncReadlinePrompt(rl);
    if (!isTty(rl)) return;
    const target = findUnderlyingInterface(rl);
    if (typeof target?._refreshLine === "function") {
      target._refreshLine();
      return;
    }
    paintPromptLine(rl);
  }

  function stripTrailingTab(rl) {
    if (!rl || typeof rl.line !== "string") return;
    if (rl.line.endsWith("\t")) {
      const next = rl.line.slice(0, -1);
      try {
        rl.line = next;
      } catch {
        return;
      }
      if (typeof rl.cursor === "number" && rl.cursor > 0) rl.cursor -= 1;
    }
    refreshPrompt(rl);
  }

  function handleTabKeypress(key, rl, onShortcut) {
    key = normalizeTabKey(key);
    if (key?.name !== "tab") return false;
    onShortcut(key, rl);
    stripTrailingTab(rl);
    return true;
  }

  return { refreshPrompt, stripTrailingTab, paintPromptLine, handleTabKeypress, syncReadlinePrompt };
}