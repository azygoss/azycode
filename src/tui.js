import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearLine, cursorTo, moveCursor } from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output, stderr } from "node:process";
import { execFileSync } from "node:child_process";
import { runAgent } from "./agent.js";
import { LlmClient } from "./llm.js";
import { applyPermissionProfile, azyHome, configPath, formatAgentStepLimit, loadConfig, loadState, maskSecret, resolveAgentMaxSteps, saveConfig, saveState, MODES, REASONING_LEVELS, normalizeMode, rotateMode, rotateReasoning } from "./config.js";
import { loadCustomCommands, resolveCustomCommand } from "./commands.js";
import { compactConversationDeterministic, compactConversationWithModel } from "./compaction.js";
import { loadHookConfig } from "./hooks.js";
import { AgentCancelledError, AgentStepLimitError } from "./agent-errors.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { listSkills } from "./skills.js";
import { gitGuard } from "./guard.js";
import {
  accent,
  approvalPanel,
  blank,
  bold,
  box,
  brand,
  brandBanner,
  chip,
  createStreamPanel,
  dim,
  error as errorText,
  faint,
  grokActionRow,
  grokRunMeta,
  grokUserBar,
  header as renderHeader,
  highlightTerms,
  helpPanel,
  paletteHintLine,
  icon,
  info as infoText,
  keyValueList,
  list,
  listPanel,
  muted,
  paint,
  padEnd,
  palettePanel,
  panel,
  prettyMs,
  progressBar,
  promptStatus,
  renderTable,
  renderGrokResponse,
  responsePanel,
  rule,
  section as sectionText,
  shellPanel,
  spinnerFrame,
  spinnerRunLabel,
  startSpinner,
  statCells,
  statusDot,
  statusPanel,
  stopSpinner,
  stripAnsi,
  style,
  subtle,
  success as successText,
  title as titleText,
  truncate,
  visibleLength,
  warn as warnText,
  enhancedWelcomeScreen,
  errorPanel,
  estimateCost,
  randomTip,
  costDisplay,
  toastMessage,
  toolCard,
  thinkingBlock,
  liveMetricsBar,
  sessionCard
} from "./ui.js";
import { providerDiagnostics, providerModelList, providerNames, providerPreset, withProviderModels } from "./providers.js";
import { syncConfiguredProviderModels, syncProviderModels } from "./model-sync.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";
import { contextPack, formatContextPack } from "./context.js";
import { toolCatalog } from "./tools.js";
import { createAgentProgress, formatAgentRunStats, formatAgentRunSummary, formatSessionTranscript, formatToolRunLine, hasActiveProvider, runtimeSnapshot, sessionListEntries, summarizeAgentRun, toolRunListEntries, withAgentAbort } from "./harness.js";
import { trimConversation } from "./conversation.js";
import { discoverProjectInstructions, listInstructionSources } from "./instructions.js";
import { expandFileReferences } from "./prompt-expand.js";
import { execFileCancellable } from "./exec.js";
import { formatActiveTodos, formatTodoList, listTodos, runTodoAction } from "./todos.js";
import { readComposerLine } from "./composer-input.js";
import { fitTerminalWidth, maxBottomPaneRows, terminalRows, writeInBottomPane } from "./screen.js";
import { createPromptSession, normalizeTabKey, syncTuiPrompt } from "./terminal-input.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];
const MAX_CONVERSATION_MESSAGES = 80;
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Command catalog, aliases, help groups, and the dispatch registry live in the
// dedicated tui/commands.js module (plan.md §2.3). Re-exported here for the
// handful of call sites that still import them from tui.js.
import {
  TUI_COMMANDS,
  TOOL_POLICY_MODES,
  helpGroups,
  COMMAND_HANDLERS,
  registerCommand,
  resolveCommandName,
  dispatchCommand
} from "./tui/commands.js";
export { TUI_COMMANDS, TOOL_POLICY_MODES, helpGroups, registerCommand };

const AGENT_BORDER = "rounded";



function tuiWidth() {
  return fitTerminalWidth(output, 2);
}

function tuiEmit(text = "", stream = output) {
  if (stream.isTTY) stream.write("\x1b[?25h");
  stream.write(text);
}

export function tuiWriteln(text = "", stream = output) {
  tuiEmit(`${text}\n`, stream);
}

function tuiBlank(stream = output) {
  tuiWriteln("", stream);
}

// ponytail: shared "… N more" footer for list commands that cap their output.
function printMoreFooter(total, shown, hint) {
  if (total <= shown) return;
  const more = hint ? `… ${total - shown} more (${hint})` : `… ${total - shown} more`;
  console.log(`  ${faint(more)}`);
}

function emitLine(line, { tty = output.isTTY, stream = output } = {}) {
  if (tty) tuiWriteln(line, stream);
  else console.log(line);
}

function emitLines(lines, options = {}) {
  for (const line of lines) emitLine(line, options);
}

function composerInitialRows(state) {
  const dockRows = getComposerDockLines(state).length;
  return Math.min(maxBottomPaneRows(output), Math.max(6, dockRows + 2));
}

export async function launchTui({ cwd = process.cwd() } = {}) {
  const cfg = loadConfig();
  const state = {
    cfg,
    cwd,
    mode: normalizeMode(cfg.mode),
    includeContext: false,
    progress: true,
    streamResponses: Boolean(cfg.streamResponses),
    conversation: [],
    skills: [],
    subagent: null,
    maxConversationMessages: cfg.maxConversationMessages || MAX_CONVERSATION_MESSAGES,
    history: [],
    historyIndex: -1,
    sessionCost: 0,
  };
  printWelcome(state);
  const promptSession = createPromptSession({
    output,
    getPrompt: () => promptLabel(state, { styled: false })
  });

  if (!input.isTTY) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("/")) {
        const done = await handleCommand(line, state);
        if (done === "exit") break;
      } else {
        await askAgent(line, state);
      }
    }
    return;
  }

  const rl = readlinePromises.createInterface({ input, output, completer: (line) => completeTuiInput(line, state) });
  const renderPane = createComposerRenderer(state);
  const originalLog = console.log;
  console.log = (...args) => {
    let text = args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" ");
    // ponytail: strip ANSI when output is piped/non-TTY so captures stay clean.
    if (!output.isTTY) text = stripAnsi(text);
    if (!text) {
      tuiBlank();
      return;
    }
    for (const line of text.split("\n")) tuiWriteln(line);
  };
  try {
    while (true) {
      state.acceptingInput = true;
      const line = (await readComposerLine({
        input,
        output,
        readlineInterface: rl,
        renderPane,
        getPaletteItems: (value) => (value.startsWith("/") ? filterPaletteCommands(state, value.slice(1).trim()) : []),
        resolveSlashSubmit: (value, items, selection) => resolveSlashSubmit(value, items, selection),
        completeLine: (value) => completeTuiInput(value, state),
        onShortcut: (key) => applyShortcut(key, state, { 
          persist: true,
          notify: (msg) => console.log(`  ${msg}`)
        }),
        onClearScreen: () => {
          output.write("\x1Bc");
          printWelcome(state);
        },
        initialRows: composerInitialRows(state),
        history: state.history
      })).trim();
      state.acceptingInput = false;
      if (!line) continue;
      try {
        if (line.startsWith("/")) {
          const done = await handleCommand(line, state, rl, promptSession);
          if (rl) rl.pause();
          if (done === "exit") break;
        } else if (line.startsWith("!")) {
          await runLocalShell(line.slice(1).trim(), state, rl, promptSession);
        } else {
          await askAgent(line, state, rl, promptSession);
          if (line && !line.startsWith("/")) {
            // ponytail: cap history to avoid unbounded growth over a long session.
            state.history = [...state.history.slice(-200), line];
            state.historyIndex = -1;
          }
        }
      } catch (error) {
        // Isolate per-command failures so one bad command never tears down the TUI.
        const message = error?.code === "ERR_ASSERTION" || error?.name === "AssertionError"
          ? error.message
          : (error?.message || String(error));
        tuiWriteln(`${errorText("✗")} ${truncate(String(message), tuiWidth() - 4)}`);
        try { state.acceptingInput = false; } catch { /* state already torn down */ }
      }
    }
  } finally {
    console.log = originalLog;
    rl.close();
  }
}

function printWelcome(state) {
  const repo = path.basename(state.cwd);
  const git = gitSummary(state.cwd);
  const connected = hasActiveProvider(state.cfg);
  const saved = loadState();
  const sessions = Object.entries(saved.sessions || {});
  const lastSession = sessions.length ? sessions.sort((a, b) => String(b[1]?.createdAt || '').localeCompare(String(a[1]?.createdAt || '')))[0] : null;
  blank();
  for (const line of enhancedWelcomeScreen({
    connected,
    workspace: repo,
    branch: git.branch,
    nodeVersion: process.version,
    platform: process.platform,
    terminalWidth: tuiWidth(),
    sessionCount: sessions.length,
    lastSession: lastSession ? { id: lastSession[0], prompt: lastSession[1]?.prompt, mode: lastSession[1]?.mode } : null,
    model: state.cfg.activeModel,
    mode: state.mode,
    reasoning: state.cfg.reasoning,
    width: tuiWidth()
  })) {
    console.log(line);
  }
  blank();
}

function getComposerDockLines(state) {
  // Model, mode, and reasoning are now displayed in the enhanced welcome screen.
  // We return an empty array so the composer dock is completely removed,
  // leaving just a clean prompt like Claude Code!
  return [];
}

export function filterPaletteCommands(state, filter = "") {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const items = [];
  for (const group of commandPaletteGroups(state)) {
    for (const [command, summary] of group.items) {
      const haystack = `${command} ${summary}`.toLowerCase();
      if (terms.length && !terms.every((term) => haystack.includes(term))) continue;
      items.push([command, summary]);
    }
  }
  return items;
}

export function resolveSlashSubmit(line, items, selection = 0) {
  const typed = String(line ?? "").trim();
  if (!typed.startsWith("/")) return typed;
  const exact = items.find(([command]) => command === typed);
  if (exact) return typed;
  const body = typed.slice(1).trim();
  if (!body.includes(" ") && items[selection]?.[0]) return items[selection][0];
  return typed;
}

const PALETTE_HINTS = [
  { key: "↑↓", label: "pick" },
  { key: "Enter", label: "run" },
  { key: "Tab", label: "fill" },
  { key: "Esc", label: "clear" }
];

function formatPaletteCommand(command, terms, picked) {
  const highlighted = highlightTerms(String(command), terms);
  return picked ? bold(brand(highlighted)) : style(highlighted, "brightWhite");
}

export function buildSelectablePaletteLines(state, filter = "", { maxLines = 8, selection = 0 } = {}) {
  const items = filterPaletteCommands(state, filter);
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const width = tuiWidth();
  if (!items.length) {
    return [
      muted(`  ${filter ? "no matching commands" : `${countPaletteCommands(state)} commands — type to filter`}`),
      paletteHintLine(PALETTE_HINTS)
    ];
  }
  const commandWidth = items.reduce((max, [command]) => Math.max(max, String(command).length), 0);
  const visible = items.slice(0, Math.max(1, maxLines - 1));
  const lines = visible.map(([command, summary], index) => {
    const picked = index === selection;
    const marker = picked ? brand(bold("›")) + " " : "  ";
    const cmd = formatPaletteCommand(command, terms, picked);
    const prefix = `${marker}${padEnd(cmd, commandWidth + 2)}`;
    const avail = Math.max(0, width - visibleLength(prefix));
    const desc = avail > 0 ? subtle(truncate(summary, avail)) : "";
    return truncate(prefix + desc, width);
  });
  if (items.length > visible.length) {
    lines.push(truncate(subtle(`  … ${items.length - visible.length} more — type to filter`), width));
  }
  lines.push(paletteHintLine(PALETTE_HINTS));
  return lines;
}

export function buildLivePaletteLines(state, filter = "", maxLines = 10) {
  if (maxLines < 3) return [];
  const panelLines = buildCommandPaletteLines(state, filter);
  if (!panelLines.length) {
    return filter ? [muted("  no matching commands")] : [muted(`  ${countPaletteCommands(state)} commands — type to filter`)];
  }
  if (panelLines.length <= maxLines) return panelLines;
  return [
    ...panelLines.slice(0, maxLines - 1),
    truncate(muted(`  … ${panelLines.length - maxLines + 1} more — type to filter`), tuiWidth())
  ];
}

export function maxComposerPaletteLines(state, { line = "" } = {}) {
  const dockRows = getComposerDockLines(state).length;
  const promptRows = Math.max(1, (String(line).match(/\n/g) || []).length + 1);
  const reserved = dockRows + promptRows + 2;
  return Math.min(6, Math.max(3, maxBottomPaneRows(output) - reserved));
}

export function buildComposerPaneLines(state, { line = "", paletteFilter = null, paletteSelection = 0 } = {}) {
  const rows = [...getComposerDockLines(state)];
  if (paletteFilter !== null) {
    const maxLines = maxComposerPaletteLines(state, { line });
    rows.push(subtle("  " + "─".repeat(Math.max(0, tuiWidth() - 4))));
    rows.push(...buildSelectablePaletteLines(state, paletteFilter, { maxLines, selection: paletteSelection }));
  }
  const parts = line ? line.split("\n") : [""];
  for (let i = 0; i < parts.length; i++) {
    const prefix = i === 0 ? promptLabel(state) : "  ";
    const input = parts[i] ? bold(style(parts[i], "brightWhite")) : "";
    rows.push(`${prefix}${input}`);
  }
  return rows;
}

function createComposerRenderer(state) {
  const renderer = ({ line, cursor, layout, paletteSelection = 0 }) => {
    const paletteFilter = line.startsWith("/") ? line.slice(1).trim() : null;
    const rows = buildComposerPaneLines(state, { line, paletteFilter, paletteSelection });
    const maxCol = tuiWidth();
    for (let i = 0; i < layout.bottomRows; i++) {
      const row = i < rows.length ? rows[i] : "";
      writeInBottomPane(layout, i, truncate(row, maxCol), output);
    }
    const before = line.slice(0, cursor);
    const lineIndex = (before.match(/\n/g) || []).length;
    const colInLine = before.length - (before.lastIndexOf("\n") + 1);
    const inputLineCount = Math.max(1, (line.match(/\n/g) || []).length + 1);
    renderer.promptOffset = Math.min(
      layout.bottomRows - 1,
      rows.length - inputLineCount + lineIndex
    );
    renderer.promptColumn = () => (lineIndex === 0
      ? visibleLength(promptLabel(state, { styled: false }))
      : 2) + colInLine;
    return rows.length;
  };
  return renderer;
}

export function promptLabel(state, { styled = true } = {}) {
  return styled ? `${brand(bold("›"))} ` : "› ";
}

export { normalizeTabKey } from "./terminal-input.js";

export function applyShortcut(key, state, options = {}) {
  key = normalizeTabKey(key);
  if (key?.name !== "tab") return;
  if (state.acceptingInput === false && options.force !== true) return;
  if (options.rl?.line?.startsWith("/")) return;
  const persist = options.persist !== false;
  const notify = options.notify || (() => options.promptSession?.refreshPrompt(options.rl));
  if (key.shift) {
    state.mode = rotateMode(state.mode);
    state.cfg.mode = state.mode;
    if (persist) saveConfig(state.cfg);
    notify(`${icon("chevron")} mode: ${state.mode}`);
  } else {
    state.cfg.reasoning = rotateReasoning(state.cfg.reasoning);
    if (persist) saveConfig(state.cfg);
    notify(`${icon("chevron")} reasoning: ${state.cfg.reasoning}`);
  }
}

const MAX_COMPACT_PALETTE_LINES = 6;

function countPaletteCommands(state) {
  let total = 0;
  for (const group of commandPaletteGroups(state)) total += group.items.length;
  return total;
}

export function buildCompactPaletteHints(state, filter = "", maxLines = MAX_COMPACT_PALETTE_LINES) {
  const items = filterPaletteCommands(state, filter);
  const width = tuiWidth();
  const commandWidth = items.reduce((max, [command]) => Math.max(max, String(command).length), 0);
  const lines = items.slice(0, maxLines).map(([command, summary]) => {
    const prefix = `  ${padEnd(style(String(command), "brightWhite"), commandWidth + 2)}`;
    const avail = Math.max(0, width - visibleLength(prefix));
    const desc = avail > 0 ? muted(truncate(summary, avail)) : "";
    return truncate(prefix + desc, width);
  });
  if (items.length > maxLines) {
    lines.push(truncate(muted(`  … ${items.length - maxLines} more — type to filter`), width));
  }
  return lines;
}

export { findUnderlyingInterface } from "./terminal-input.js";

export function stripTrailingTab(rl, state) {
  const session = createPromptSession({
    output,
    getPrompt: () => promptLabel(state, { styled: false })
  });
  session.stripTrailingTab(rl);
}

export function completeTuiInput(line, state) {
  if (!line.startsWith("/")) return [[], line];
  const body = line.slice(1);
  const hasTrailingSpace = /\s$/.test(line);
  const parts = body.split(/\s+/).filter(Boolean);
  const command = parts[0] || "";
  if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
    const custom = loadCustomCommands(state.cwd).map((entry) => entry.name).filter((name) => !TUI_COMMANDS.includes(name));
    const allCommands = [...TUI_COMMANDS, ...custom];
    const completions = allCommands.map((item) => `/${item}`).filter((item) => item.startsWith(`/${command}`));
    return [completions.length ? completions : allCommands.map((item) => `/${item}`), line];
  }

  const argPrefix = hasTrailingSpace ? "" : parts.at(-1);
  const fixedArgs = hasTrailingSpace ? parts.slice(1) : parts.slice(1, -1);
  const base = `/${command}${fixedArgs.length ? ` ${fixedArgs.join(" ")}` : ""} `;
  const candidates = tuiArgCandidates(command, fixedArgs, state);
  const completions = candidates
    .filter((item) => item.startsWith(argPrefix))
    .map((item) => `${base}${item}`);
  return [completions.length ? completions : candidates.map((item) => `${base}${item}`), line];
}

function tuiArgCandidates(command, fixedArgs, state) {
  if (command === "mode") return MODES;
  if (command === "reasoning") return REASONING_LEVELS;
  if (command === "profile") return PROFILES;
  if (command === "login") return providerNames();
  if (command === "provider") return Object.keys(state.cfg.providers || {}).length ? Object.keys(state.cfg.providers) : providerNames();
  if (command === "agent") return ["off", ...Object.keys(state.cfg.subagents || {})];
  if (command === "help") return TUI_COMMANDS;
  if (command === "goal") return ["create", "status", "stop"];
  if (command === "context") return ["show"];
  if (command === "memory") return ["add", "remove", "list"];
  if (command === "todo") return ["list", "add", "complete", "clear"];
  if (command === "model" && fixedArgs.length === 0) return ["sync", ...modelSelectionEntries(state).map((entry) => entry.id)];
  if (command === "model" && fixedArgs[0] === "sync") return ["all"];
  if (command === "models" && fixedArgs.length === 0) return ["sync"];
  if (command === "models" && fixedArgs[0] === "sync") return ["all"];
  if (command === "tool" && fixedArgs.length === 0) return Object.keys(state.cfg.toolPolicy || {});
  if (command === "tool" && fixedArgs.length === 1) return TOOL_POLICY_MODES;
  if (command === "mission" && fixedArgs.length === 0) return ["dry-run", "run", "report", "status"];
  return [];
}

async function askAgent(prompt, state, rl = null, promptSession = null) {
  state.cfg = loadConfig();
  const tty = output.isTTY;
  if (rl) rl.pause();
  const { prompt: expandedPrompt, attachments } = expandFileReferences(prompt, state.cwd);
  if (!hasActiveProvider(state.cfg)) {
    tuiBlank();
    emitLines(box([
      `${warnText(icon("warn"))} ${bold("Provider required")}`,
      "",
      `${muted("Connect a model provider before running tasks.")}`,
      `${muted("In this workspace, type")} ${subtle("/login")} ${muted("and follow the prompts.")}`
    ], { width: tuiWidth(), frame: AGENT_BORDER, title: "setup" }), { tty });
    tuiBlank();
    return;
  }
  const maxSteps = resolveAgentMaxSteps(state.cfg);
  const W = tuiWidth();
  tuiBlank();
  printAgentRunHeader(state, expandedPrompt, maxSteps, attachments, W, { tty });

  const spinner = state.progress && !state.streamResponses
    ? startSpinner({
      label: spinnerRunLabel({ step: 0, maxSteps, tool: "starting", width: Math.min(18, Math.max(10, Math.floor(W / 6))) }),
      stream: stderr,
      isTTY: stderr.isTTY
    })
    : null;
  let streamed = false;
  const streamPanel = state.streamResponses
    ? createStreamPanel({ width: W, stream: output, onLine: (line) => emitLine(line, { tty }) })
    : null;
  const onEvent = state.progress
    ? createAgentProgress({
      spinner,
      maxSteps,
      style: "grok",
      quietModelTurns: true,
      panelWidth: W,
      onLine: (line, event) => {
        if (event?.type === "model_token") return;
        emitLine(line, { tty });
      }
    })
    : null;
  try {
    const result = await withAgentAbort(async (signal) => runAgent({
      cfg: state.cfg,
      cwd: state.cwd,
      prompt: expandedPrompt,
      mode: state.mode,
      maxSteps,
      includeContext: state.includeContext,
      onEvent,
      conversation: state.conversation,
      returnSession: true,
      confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
      subagent: state.subagent,
      skills: state.skills,
      signal,
      stream: state.streamResponses,
      onToken: state.streamResponses
        ? (event) => {
          if (!streamed) {
            streamed = true;
            if (spinner) stopSpinner();
          }
          streamPanel?.write(event.delta || "");
        }
        : null,
      onModeChange: ({ mode, persist }) => {
        if (state.subagent) return;
        state.mode = mode;
        state.cfg.mode = mode;
        if (persist) saveConfig(state.cfg);
      }
    }), {
      onCancel: () => {
        if (spinner) stopSpinner({ finalStyle: "warn", finalLabel: `cancelling  ${truncate(prompt, 36)}` });
        tuiBlank();
        emitLine(warnText(`  ${icon("warn")} Cancelling run… (Ctrl+C again to exit)`), { tty });
      }
    });
    state.conversation = trimConversation(result.messages.filter((message) => message.role !== "system"), state.maxConversationMessages);
    if (spinner) stopSpinner();
    if (streamed) {
      streamPanel?.close();
      tuiBlank();
    } else {
      emitLines(renderGrokResponse(result.content, { width: W }), { tty });
    }
    // Accumulate session cost from usage
    if (result.usage) {
      const runCost = estimateCost(
        state.cfg.activeModel,
        result.usage.prompt_tokens || result.usage.input_tokens || 0,
        result.usage.completion_tokens || result.usage.output_tokens || 0
      );
      if (runCost) state.sessionCost = (state.sessionCost || 0) + runCost.totalCost;
    }
    if (state.progress && result.events?.length) {
      const meta = grokRunMeta(formatAgentRunStats(result.events, { maxSteps }));
      if (meta) emitLine(meta, { tty });
    }
    tuiBlank();
  } catch (error) {
    if (spinner) stopSpinner({ finalStyle: "error", finalLabel: `error  ${truncate(prompt, 36)}` });
    streamPanel?.close();
    tuiBlank();
    if (error instanceof AgentCancelledError) {
      emitLines(errorPanel({
        title: 'Run Cancelled',
        message: 'The agent run was cancelled by user.',
        suggestion: 'Your conversation context is preserved. Type your next message to continue.',
        width: tuiWidth()
      }).lines || [warnText('  Run cancelled.')], { tty });
    } else if (error instanceof AgentStepLimitError) {
      const errLines = errorPanel({
        title: 'Step Limit Reached',
        message: 'The agent exhausted its step budget before producing a final answer.',
        suggestion: 'Try /compact to reduce context, or increase maxSteps in config.',
        retryHint: 'You can also say "continue" to pick up where it left off.',
        width: tuiWidth()
      }).lines;
      if (errLines) emitLines(errLines, { tty });
      else {
        emitLine(warnText('  Step limit reached before a final answer.'), { tty });
      }
      if (error.report) {
        emitLine(`  ${muted('Run steps:')}`, { tty });
        for (const rline of error.report.split('\n')) emitLine(muted(`  ${rline}`), { tty });
      }
      if (error.partialContent) {
        tuiBlank();
        emitLines(renderGrokResponse(error.partialContent, { width: tuiWidth() }), { tty });
      }
    } else {
      const errLines = errorPanel({
        title: 'Agent Error',
        message: error.message,
        code: error.code || error.status || null,
        suggestion: error.message.includes('rate') || error.message.includes('429')
          ? 'Wait a moment and try again, or switch to a different model with /model.'
          : error.message.includes('key') || error.message.includes('auth')
            ? 'Check your API key with /credentials or reconnect with /login.'
            : 'Try /status to check your setup, or /health to verify provider connectivity.',
        retryHint: error.message.includes('timeout') ? 'The request timed out. Try a simpler prompt or /compact first.' : null,
        width: tuiWidth()
      }).lines;
      if (errLines) emitLines(errLines, { tty });
      else emitLine(errorText(`${icon('cross')}  ${error.message}`), { tty });
    }
    tuiBlank();
  }
}

async function runLocalShell(command, state, rl = null, promptSession = null) {
  if (!command) return;
  const tty = output.isTTY;
  if (rl) rl.pause();
  tuiBlank();
  try {
    const { stdout, stderr } = await execFileCancellable(process.env.SHELL || "sh", ["-lc", command], {
      cwd: state.cwd,
      timeout: 120_000,
      maxBuffer: 1024 * 1024 * 4
    });
    const text = [stdout, stderr].filter(Boolean).join("\n").trim();
    emitLines(shellPanel(command, text, { width: tuiWidth() }), { tty });
  } catch (error) {
    emitLines(shellPanel(command, error.message, { width: tuiWidth(), title: "shell error" }), { tty });
  }
  tuiBlank();
}

function printAgentRunHeader(state, prompt, maxSteps, attachments, width = tuiWidth(), { tty = output.isTTY } = {}) {
  emitLine(grokUserBar(prompt, { width }), { tty });
  if (attachments.length) {
    emitLine(grokActionRow("Attached", attachments.join(", ")), { tty });
  }
}

async function confirmInTui(rl, question) {
  const tty = output.isTTY;
  tuiBlank();
  emitLines(approvalPanel(question, { width: tuiWidth() }), { tty });
  rl.resume();
  const answer = (await rl.question(`${warnText(icon("warn"))} ${muted("Allow?")} ${muted("[y/n]")} (n): `)).trim().toLowerCase();
  rl.pause();
  return answer === "y" || answer === "yes" || answer === "evet" || answer === "e";
}

async function handleCommand(line, state, rl = null, promptSession = null) {
  if (rl) rl.pause();
  const [command, ...args] = line.slice(1).trim().split(/\s+/);
  if (!command) {
    printCommandPalette(state);
    return;
  }
  if (command === "exit" || command === "quit") return "exit";
  if (command === "cost") {
    printCostSummary(state);
    return;
  }
  if (command === "help") {
    printHelp(args[0]);
    return;
  }
  if (command === "clear") {
    if (output.isTTY) output.write("\x1b[2J\x1b[H");
    printWelcome(state);
    return;
  }
  if (command === "new") {
    state.conversation = [];
    console.log(`${successText(icon("check"))} ${muted("conversation: cleared")}`);
    return;
  }
  if (command === "compact") {
    const before = state.conversation.length;
    const keepRecent = Math.max(8, Math.floor((state.maxConversationMessages || 40) * 0.5));
    if (state.cfg.compaction === "llm" && hasActiveProvider(state.cfg)) {
      try {
        const client = new LlmClient(state.cfg);
        state.conversation = await compactConversationWithModel({
          client,
          messages: state.conversation,
          model: state.cfg.activeModel,
          keepRecent
        });
        console.log(`${muted(icon("chevron"))} conversation: ${before} -> ${state.conversation.length} messages (llm)`);
      } catch (error) {
        state.conversation = trimConversation(state.conversation, keepRecent);
        console.log(`${warnText(icon("warn"))} llm compact failed (${error.message}); trimmed to ${state.conversation.length}`);
      }
    } else if (state.cfg.compaction === "deterministic") {
      state.conversation = compactConversationDeterministic(state.conversation, {
        keepRecent,
        todoState: formatActiveTodos(state.cwd)
      });
      console.log(`${muted(icon("chevron"))} conversation: ${before} -> ${state.conversation.length} messages (deterministic)`);
    } else {
      state.conversation = trimConversation(state.conversation, keepRecent);
      console.log(`${muted(icon("chevron"))} conversation: ${before} -> ${state.conversation.length} messages`);
    }
    return;
  }
  if (command === "hooks") {
    printHooks(state);
    return;
  }
  if (command === "commands") {
    printCustomCommands(state);
    return;
  }
  if (command === "reload") {
    state.cfg = loadConfig();
    state.mode = state.cfg.mode;
    console.log(`${successText(icon("check"))} ${muted("reloaded config from")} ${faint(configPath())}`);
    return;
  }
  if (command === "mode") {
    const next = normalizeMode(args[0]);
    if (!MODES.includes(next)) console.log(`${warnText(icon("warn"))} mode: ${MODES.join(", ")}`);
    else {
      state.mode = next;
      state.cfg.mode = next;
      saveConfig(state.cfg);
      console.log(`${successText(icon("check"))} ${muted("mode:")} ${style(next, modeColor(next))}`);
    }
    return;
  }
  if (command === "reasoning") {
    const next = args[0];
    if (!REASONING_LEVELS.includes(next)) console.log(`${warnText(icon("warn"))} reasoning: ${REASONING_LEVELS.join(", ")}`);
    else {
      state.cfg.reasoning = next;
      saveConfig(state.cfg);
      console.log(`${successText(icon("check"))} ${muted("reasoning:")} ${infoText(next)}`);
    }
    return;
  }
  if (command === "model") {
    if (args[0] === "sync") {
      await handleModels(args, state);
      return;
    }
    const next = args.join(" ");
    if (!next) await chooseModel(state, rl);
    else {
      selectModel(state, next);
    }
    return;
  }
  if (command === "models") {
    await handleModels(args, state);
    return;
  }
  if (command === "providers") {
    printProviders(state);
    return;
  }
  if (command === "provider") {
    const name = args[0];
    if (!name) {
      await chooseConfiguredProvider(state, rl);
    } else if (!state.cfg.providers?.[name]) {
      console.log(`${warnText(icon("warn"))} Provider '${name}' is not configured. Run: azycode login ${name}`);
    } else {
      state.cfg.providers[name] = withProviderModels(state.cfg, name, state.cfg.providers[name]);
      state.cfg.activeProvider = name;
      state.cfg.activeModel = state.cfg.providers[name].model;
      saveConfig(state.cfg);
      console.log(`${successText(icon("check"))} ${muted("provider:")} ${state.cfg.activeProvider}/${state.cfg.activeModel}`);
    }
    return;
  }
  if (command === "credentials") {
    printCredentials(state);
    return;
  }
  if (command === "keys") {
    printKeys();
    return;
  }
  if (command === "profile") {
    const next = args[0];
    if (!PROFILES.includes(next)) console.log(`${warnText(icon("warn"))} profile: ${PROFILES.join(", ")}`);
    else {
      state.cfg.permissionProfile = next;
      applyPermissionProfile(state.cfg);
      saveConfig(state.cfg);
      console.log(`${successText(icon("check"))} ${muted("profile:")} ${accent(next)}`);
      printPolicySummary(state);
    }
    return;
  }
  if (command === "context") {
    if (args[0] === "show") {
      console.log(`${muted("building context…")}`);
      const pack = await contextPack(state.cwd, { maxFiles: 20, maxBytes: 40000 });
      console.log(`${muted(icon("chevron"))} ${formatContextPack(pack)}`);
      return;
    }
    state.includeContext = !state.includeContext;
    console.log(`${muted(icon("chevron"))} context: ${state.includeContext ? successText("on") : muted("off")}`);
    return;
  }
  if (command === "progress") {
    state.progress = !state.progress;
    console.log(`${muted(icon("chevron"))} progress: ${state.progress ? successText("on") : muted("off")}`);
    return;
  }
  if (command === "stream") {
    state.streamResponses = !state.streamResponses;
    state.cfg.streamResponses = state.streamResponses;
    saveConfig(state.cfg);
    console.log(`${muted(icon("chevron"))} stream: ${state.streamResponses ? successText("on") : muted("off")}`);
    return;
  }
  if (command === "instructions") {
    const sources = listInstructionSources(state.cwd);
    console.log(`${brand(icon("chevronRight"))} ${bold("Instruction sources")}`);
    for (const source of sources) console.log(`  ${muted(icon("bullet"))} ${source}`);
    const text = discoverProjectInstructions(state.cwd);
    if (text) console.log(`\n${text}`);
    else console.log(muted("  (none — add AGENTS.md or .azycode/rules.md)"));
    return;
  }
  if (command === "resume") {
    const sessionId = args[0];
    const sessions = loadState().sessions || {};
    const selectedId = sessionId && sessions[sessionId]
      ? sessionId
      : Object.entries(sessions).sort((a, b) => String(b[1]?.createdAt || "").localeCompare(String(a[1]?.createdAt || "")))[0]?.[0];
    if (!selectedId) {
      console.log(`${warnText(icon("warn"))} No saved session to resume.`);
      return;
    }
    const selected = sessions[selectedId];
    state.conversation = trimConversation(
      (selected.messages || []).filter((message) => message.role !== "system"),
      state.maxConversationMessages
    );
    if (selected.mode) state.mode = normalizeMode(selected.mode);
    console.log(`${successText(icon("check"))} resumed ${selectedId} · ${state.conversation.length} messages loaded`);
    const followUp = sessionId && args[0] === sessionId ? args.slice(1).join(" ") : args.join(" ");
    if (followUp) await askAgent(followUp, state, rl, promptSession);
    return;
  }
  if (command === "review") {
    printReview(state);
    return;
  }
  if (command === "skill") {
    const action = args[0];
    const name = args[1];
    if (action === "add" && name) {
      if (!state.cfg.skills?.[name]) {
        console.log(`${errorText(icon("cross"))} No skill named ${name}`);
        return;
      }
      state.skills = [...state.skills, name];
      console.log(`${successText(icon("check"))} ${muted("skill")} +${name} · active: ${state.skills.join(", ") || "(none)"}`);
    } else if (action === "add" && !name) {
      const items = listSkills(state.cfg);
      if (!items.length) {
        console.log(muted("No skills configured."));
        return;
      }
      const selected = await selectFromList({
        title: "Select skill to add",
        items,
        rl,
        format: (item) => `${item.name}${item.description ? ` · ${muted(item.description)}` : ""}`
      });
      if (selected) {
        if (!state.skills.includes(selected.name)) {
          state.skills = [...state.skills, selected.name];
        }
        console.log(`${successText(icon("check"))} ${muted("skill")} +${selected.name} · active: ${state.skills.join(", ") || "(none)"}`);
      }
    } else if (action === "remove" && name) {
      state.skills = state.skills.filter((s) => s !== name);
      console.log(`${successText(icon("check"))} ${muted("skill")} -${name} · active: ${state.skills.join(", ") || "(none)"}`);
    } else if (action === "remove" && !name) {
      if (!state.skills.length) {
        console.log(muted("No active skills to remove."));
        return;
      }
      const items = listSkills(state.cfg).filter((item) => state.skills.includes(item.name));
      const selected = await selectFromList({
        title: "Select skill to remove",
        items,
        rl,
        format: (item) => `${item.name}${item.description ? ` · ${muted(item.description)}` : ""}`
      });
      if (selected) {
        state.skills = state.skills.filter((s) => s !== selected.name);
        console.log(`${successText(icon("check"))} ${muted("skill")} -${selected.name} · active: ${state.skills.join(", ") || "(none)"}`);
      }
    } else if (action === "list") {
      const items = listSkills(state.cfg);
      const active = new Set(state.skills);
      if (!items.length) console.log(muted("No skills configured."));
      else items.forEach((s) => console.log(`${active.has(s.name) ? successText("●") : muted("○")} ${s.name}${s.description ? ` · ${muted(s.description)}` : ""}`));
    } else if (action === "clear") {
      state.skills = [];
      console.log(`${successText(icon("check"))} ${muted("skills cleared")}`);
    } else {
      console.log(`${warnText(icon("warn"))} Usage: /skill add [name] | /skill remove [name] | /skill list | /skill clear`);
    }
    return;
  }
  if (command === "dashboard") {
    printDashboard(state);
    return;
  }
  if (command === "workspace") {
    printWorkspace(state);
    return;
  }
  if (command === "sessions") {
    printSessions();
    return;
  }
  if (command === "session") {
    printSession(args);
    return;
  }
  if (command === "tools") {
    printToolRuns();
    return;
  }
  if (command === "policy") {
    printToolPolicy(state);
    return;
  }
  if (command === "tool") {
    handleToolPolicy(args, state);
    return;
  }
  if (command === "goals") {
    printGoals();
    return;
  }
  if (command === "goal") {
    handleGoal(args);
    return;
  }
  if (command === "missions") {
    printMissions();
    return;
  }
  if (command === "mission") {
    await handleMission(args, state, rl);
    return;
  }
  if (command === "memory") {
    handleMemory(args);
    return;
  }
  if (command === "todo") {
    handleTodo(args, state);
    return;
  }
  if (command === "agents") {
    printAgents(state);
    return;
  }
  if (command === "agent") {
    const name = args[0];
    if (!name) {
      console.log(`${muted(icon("chevron"))} agent: ${state.subagent?.name ? brand(`@${state.subagent.name}`) : muted("off")}`);
    } else if (name === "off") {
      state.subagent = null;
      console.log(`${muted(icon("chevron"))} agent: off`);
    } else if (!state.cfg.subagents?.[name]) {
      console.log(`${warnText(icon("warn"))} No subagent '${name}'. Use /agents.`);
    } else {
      state.subagent = { name, ...state.cfg.subagents[name] };
      console.log(`${successText(icon("check"))} ${muted("agent:")} ${brand(`@${name}`)}`);
    }
    return;
  }
  if (command === "login") {
    await loginProvider(state, rl);
    return;
  }
  if (command === "status") {
    printStatus(state);
    return;
  }
  if (command === "health") {
    await printHealth(state);
    return;
  }
  if (command === "doctor") {
    printDoctor(state);
    return;
  }
  const custom = resolveCustomCommand(line, state.cwd);
  if (custom) {
    await askAgent(custom.prompt, state, rl, promptSession);
    return;
  }
  console.log(`${warnText(icon("warn"))} Unknown command: /${command}. Use /help.`);
}

function modeColor(mode) {
  if (mode === "plan") return "info";
  if (mode === "build") return "success";
  if (mode === "always-approve") return "warn";
  if (mode === "goal") return "brand";
  if (mode === "review") return "accent";
  return "muted";
}

function printHelp(topic = null) {
  if (topic) {
    const topics = {
      model: [
        "/model",
        "/model <provider/model>",
        "/model sync",
        "/model sync all"
      ],
      login: [
        "/login",
        "/credentials",
        "/health"
      ],
      mission: [
        "/mission dry-run <file>",
        "/mission run <file>",
        "/mission report <id>"
      ],
      goal: [
        "/goal create <text>",
        "/goal status [id]",
        "/goal stop [id]"
      ],
      review: [
        "/review",
        "/profile read-only",
        "/policy"
      ]
    };
    const rows = topics[topic];
    if (!rows) {
      console.log(`${warnText(icon("warn"))} help: topics ${Object.keys(topics).join(", ")}`);
      return;
    }
    blank();
    console.log(`${brand(icon("chevronRight"))} ${bold(`Help: ${topic}`)}`);
    for (const row of rows) console.log(`  ${infoText(row)}`);
    blank();
    return;
  }
  printHelpGroups();
}

// helpGroups() is imported from src/tui/commands.js (plan.md §2.3).

function printHelpGroups() {
  blank();
  const footer = `${muted(icon("sparkle"))} hint: type ${infoText("/")} alone to open the command palette.`;
  for (const line of helpPanel(helpGroups(), { width: tuiWidth(), footer })) {
    console.log(line);
  }
  blank();
}

function commandPaletteGroups(state) {
  const groups = helpGroups();
  const custom = loadCustomCommands(state.cwd)
    .map((entry) => [`/${entry.name}`, entry.description || "custom command"])
    .filter(([command]) => !TUI_COMMANDS.includes(command.slice(1)));
  if (custom.length) groups.splice(2, 0, { title: "Custom", items: custom });
  return groups;
}

export function buildCommandPaletteLines(state, filter = "") {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const filteredGroups = commandPaletteGroups(state)
    .map((group) => ({
      ...group,
      items: terms.length
        ? group.items.filter(([command, summary]) => {
          const haystack = `${command} ${summary}`.toLowerCase();
          return terms.every((term) => haystack.includes(term));
        })
        : group.items
    }))
    .filter((group) => group.items.length);
  const provider = state.cfg.activeProvider || "no provider";
  const model = state.cfg.activeModel || "no model";
  const footer = statCells([
    { label: "active", value: `${provider}/${model}`, style: "info" },
    { value: state.mode, style: modeColor(state.mode) },
    { label: "reasoning", value: state.cfg.reasoning, style: "muted" }
  ]);
  return palettePanel(filteredGroups, { width: tuiWidth(), footer, highlight: terms });
}

function printFilteredCommandPalette(state, filter = "") {
  blank();
  const panelLines = buildCommandPaletteLines(state, filter);
  for (const line of panelLines) console.log(line);
  blank();
  return panelLines.length + 2;
}

function printCommandPalette(state) {
  printFilteredCommandPalette(state);
}

export { trimConversation } from "./conversation.js";

function printCostSummary(state) {
  blank();
  for (const line of costSummaryPanel({
    runs: [{ model: state.cfg.activeModel, cost: state.sessionCost }],
    sessionTotal: state.sessionCost || 0,
    width: tuiWidth()
  })) {
    console.log(line);
  }
  blank();
}

function printDashboard(state) {
  const saved = loadState();
  const guard = gitGuard(state.cwd, state.cfg);
  const W = tuiWidth();
  blank();
  const overview = keyValueList([
    ["workspace", accent(path.basename(state.cwd))],
    ["model", `${state.cfg.activeProvider || muted("none")}/${state.cfg.activeModel || muted("none")}`],
    ["mode", style(state.mode, modeColor(state.mode))],
    ["reasoning", infoText(state.cfg.reasoning)],
    ["profile", state.cfg.permissionProfile ? accent(state.cfg.permissionProfile) : muted("normal")],
    ["agent", state.subagent?.name ? brand(`@${state.subagent.name}`) : muted("off")],
    ["context", state.includeContext ? successText("on") : muted("off")],
    ["git guard", `${statusDot(guard.ok ? "ok" : "blocked")} ${guard.ok ? successText("ok") : errorText("blocked")}${guard.dirty ? faint(" · dirty") : ""}`]
  ]);
  const snap = runtimeSnapshot(state.cfg, state.cwd, { mode: state.mode });
  const counts = statCells([
    { label: "sessions", value: Object.keys(saved.sessions || {}).length, style: "info" },
    { label: "goals", value: Object.keys(saved.goals || {}).length, style: "accent" },
    { label: "missions", value: Object.keys(saved.missions || {}).length, style: "brand" },
    { label: "tools", value: (saved.toolRuns || []).length, style: "muted" },
    { label: "skills", value: snap.counts.skills, style: "brand" },
    { label: "subagents", value: snap.counts.subagents, style: "info" },
    { label: "messages", value: state.conversation.length, style: "success" },
    { label: "steps", value: snap.agentMaxSteps ? String(snap.agentMaxSteps) : "∞", style: "muted" }
  ]);
  for (const line of brandBanner([...overview, "", counts], { width: W, title: "dashboard" })) {
    console.log(line);
  }
  blank();
}

function printWorkspace(state) {
  const guard = gitGuard(state.cwd, state.cfg);
  const git = gitSummary(state.cwd);
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Workspace")}`);
  const rows = [
    ["cwd", state.cwd],
    ["config", configPath()],
    ["home", azyHome()],
    ["branch", git.branch],
    ["dirty", git.dirty],
    ["guard", guard.ok ? successText("ok") : errorText("blocked")],
    ["provider", state.cfg.activeProvider || muted("none")],
    ["model", state.cfg.activeModel || muted("none")],
    ["profile", state.cfg.permissionProfile || muted("normal")]
  ];
  for (const row of keyValueList(rows)) console.log(`  ${row}`);
  if (!guard.ok) console.log(`  ${warnText(icon("warn"))} ${warnText(guard.reason)}`);
  blank();
}

function printReview(state) {
  blank();
  console.log(`${muted("reviewing changes…")}`);
  let review;
  try {
    review = localReview(state.cwd);
  } catch (error) {
    console.log(`${warnText(icon("warn"))} Could not run review: ${error.message}`);
    blank();
    return;
  }
  console.log(formatLocalReview(review));
  const actionable = review.findings.filter((item) => item.severity !== "info");
  if (!actionable.length) {
    console.log(`${successText(icon("check"))} ${muted(`review: clean (${review.files.length} files, +${review.stats.added} -${review.stats.removed})`)}`);
  }
  blank();
}

const GIT_STDIO = ["ignore", "pipe", "ignore"];

function gitSummary(cwd) {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8", stdio: GIT_STDIO }).trim() || "detached";
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8", stdio: GIT_STDIO }).trim() ? "yes" : "no";
    return { branch, dirty };
  } catch {
    return { branch: "unknown", dirty: "unknown" };
  }
}

function printStatus(state) {
  const W = tuiWidth();
  const guard = gitGuard(state.cwd, state.cfg);
  const git = gitSummary(state.cwd);
  const saved = loadState();
  blank();
  const sessionRows = keyValueList([
    ["workspace", accent(path.basename(state.cwd))],
    ["cwd", faint(truncate(state.cwd, W - 16))],
    ["branch", git.branch],
    ["provider", state.cfg.activeProvider || warnText("not connected")],
    ["model", state.cfg.activeModel || muted("none")],
    ["mode", style(state.mode, modeColor(state.mode))],
    ["reasoning", infoText(state.cfg.reasoning)],
    ["profile", state.cfg.permissionProfile ? accent(state.cfg.permissionProfile) : muted("normal")],
    ["agent", state.subagent?.name ? brand(`@${state.subagent.name}`) : muted("off")],
    ["context", state.includeContext ? successText("on") : muted("off")],
    ["progress", state.progress ? successText("on") : muted("off")],
    ["stream", state.streamResponses ? successText("on") : muted("off")],
    ["compaction", state.cfg.compaction || "trim"],
    ["conversation", `${state.conversation.length} / ${state.maxConversationMessages} messages`]
  ]);
  const sections = [{ title: "session", rows: sessionRows }];

  if (state.cfg.activeProvider) {
    try {
      const provider = providerDiagnostics(state.cfg);
      sections.push({
        title: "provider",
        rows: keyValueList([
          ["endpoint", provider.baseUrl || muted("(custom)")],
          ["protocol", provider.protocol],
          ["chat path", provider.chatPath],
          ["api key", provider.hasApiKey ? successText(`configured (${muted(provider.apiKeySource)})`) : warnText(`missing (${provider.apiKeySource})`)]
        ])
      });
    } catch (error) {
      sections.push({ title: "provider", rows: [`${warnText(icon("warn"))} ${warnText(error.message)}`] });
    }
  } else {
    sections.push({ title: "provider", rows: [warnText("No provider connected — use /login")] });
  }

  const guardRows = guard.ok
    ? [
      ...keyValueList([
        ["status", successText("ok")],
        ["branch", guard.branch || muted("(none)")],
        ["dirty", guard.dirty ? warnText("yes") : successText("no")]
      ]),
      ...(guard.warnings || []).map((warning) => `${warnText(icon("warn"))} ${warning}`)
    ]
    : keyValueList([["status", errorText("blocked")], ["reason", guard.reason]]);
  sections.push({ title: "guard", rows: guardRows });

  sections.push({
    title: "activity",
    rows: [
      statCells([
        { label: "sessions", value: Object.keys(saved.sessions || {}).length, style: "info" },
        { label: "goals", value: Object.keys(saved.goals || {}).length, style: "accent" },
        { label: "missions", value: Object.keys(saved.missions || {}).length, style: "brand" },
        { label: "tools", value: (saved.toolRuns || []).length, style: "muted" }
      ])
    ]
  });

  for (const line of statusPanel(sections, { width: W, title: "status" })) {
    console.log(line);
  }
  blank();
}

function printSessions() {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Sessions")}`);
  blank();
  const all = sessionListEntries(loadState().sessions || {}, { promptLimit: 80 });
  const rows = all.slice(0, 10);
  for (const row of rows) {
    const cardLines = sessionCard({
      id: row.id,
      mode: row.mode,
      status: row.status,
      steps: row.steps,
      duration: row.duration,
      prompt: row.prompt,
      cost: null, // cost isn't currently tracked per session in the list view unless parsed
      width: tuiWidth()
    });
    for (const line of cardLines) console.log(`  ${line}`);
    blank();
  }
  printMoreFooter(all.length, rows.length, "/sessions for all");
}

function printSession(args) {
  const [id, format] = args;
  const sessions = loadState().sessions || {};
  if (!id) {
    console.log(`${warnText(icon("warn"))} Usage: /session <id> [json]`);
    return;
  }
  const session = sessions[id];
  if (!session) {
    console.log(`${warnText(icon("warn"))} session: no session ${id}`);
    return;
  }
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold(`Session ${id}`)}`);
  if (format === "json") {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.log(formatSessionTranscript(session, { style: "tui" }));
  }
  blank();
}

function printToolRuns() {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Tool runs")}`);
  blank();
  const all = toolRunListEntries(loadState().toolRuns || [], { limit: 1000 });
  const rows = all.slice(0, 10);
  for (const row of rows) {
    // row fields come from toolRunListEntries: tool, summary, ok, ms, session, step, at
    const lines = toolCard({
      tool: row.tool,
      status: row.ok,
      duration: row.ms != null && row.ms !== "" ? prettyMs(Number(row.ms)) : null,
      summary: row.summary || "",
      width: tuiWidth()
    });
    for (const line of lines) console.log(`  ${line}`);
    // Correlate the run with its session after the status, so the rendering reads
    // tool -> ok -> session (matches the documented /tools output contract).
    if (row.session) console.log(`  ${muted("session:")} ${row.session}`);
    blank();
  }
  printMoreFooter(all.length, rows.length);
}

async function printHealth(state) {
  const names = Object.keys(state.cfg.providers || {});
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Health")}`);
  if (!names.length) {
    console.log(`  ${muted(icon("circle"))} No providers configured. Use /login.`);
    blank();
    return;
  }
  const results = await Promise.all(names.map(async (name) => {
    try {
      const result = await new LlmClient(state.cfg, name).listModels();
      const count = Array.isArray(result) ? result.length : Object.keys(result || {}).length;
      return { name, ok: true, count };
    } catch (error) {
      return { name, ok: false, error: error.message };
    }
  }));
  for (const result of results) {
    const active = state.cfg.activeProvider === result.name ? style(icon("bullet"), "success") : muted(icon("circle"));
    if (result.ok) {
      console.log(`  ${active} ${result.name.padEnd(12)} ${successText("ok")} ${faint(`(${result.count} models)`)}`);
    } else {
      console.log(`  ${errorText(icon("cross"))} ${result.name.padEnd(12)} ${errorText("failed")} ${faint(`(${result.error})`)}`);
    }
  }
  blank();
}

function printDoctor(state) {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Doctor")}`);
  const rows = [
    ["project", state.cwd],
    ["install root", INSTALL_ROOT],
    ["node", process.version],
    ["config home", azyHome()],
    ["active provider", state.cfg.activeProvider || muted("(none)")],
    ["active model", state.cfg.activeModel || muted("(none)")]
  ];
  for (const row of keyValueList(rows)) console.log(`  ${row}`);
  blank();
}

function printToolPolicy(state) {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Tool catalog")}`);
  const rows = toolCatalog({ cwd: state.cwd, cfg: state.cfg })
    .map((tool) => ({ name: tool.name, policy: tool.policy, description: tool.description }));
  for (const line of renderTable(rows, [
    { key: "name", label: "tool" },
    { key: "policy", label: "policy" },
    { key: "description", label: "description" }
  ])) console.log(`  ${line}`);
  blank();
}

function printPolicySummary(state) {
  const values = Object.values(state.cfg.toolPolicy || {});
  const count = (mode) => values.filter((value) => value === mode).length;
  console.log(`  ${muted("policy:")} ${successText(`auto ${count("auto")}`)}  ${warnText(`ask ${count("ask")}`)}  ${errorText(`deny ${count("deny")}`)}`);
}

function handleToolPolicy(args, state) {
  const [tool, mode] = args;
  const policy = state.cfg.toolPolicy || {};
  if (tool && !mode) {
    printToolDetail(state, tool);
    return;
  }
  if (!tool || !mode) {
    console.log(`${warnText(icon("warn"))} Usage: /tool <name> <auto|ask|deny>`);
    printRows("Known tools", Object.keys(policy).sort());
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(policy, tool)) {
    console.log(`${warnText(icon("warn"))} tool: unknown '${tool}'. Use /policy.`);
    return;
  }
  if (!TOOL_POLICY_MODES.includes(mode)) {
    console.log(`${warnText(icon("warn"))} tool mode: ${TOOL_POLICY_MODES.join(", ")}`);
    return;
  }
  state.cfg.toolPolicy[tool] = mode;
  saveConfig(state.cfg);
  console.log(`${successText(icon("check"))} ${muted("tool:")} ${tool} ${muted("→")} ${style(mode, mode === "auto" ? "success" : mode === "ask" ? "warn" : "error")}`);
}

function printToolDetail(state, name) {
  const selected = toolCatalog({ cwd: state.cwd, cfg: state.cfg }).find((tool) => tool.name === name);
  if (!selected) {
    console.log(`${warnText(icon("warn"))} tool: unknown '${name}'. Use /policy.`);
    return;
  }
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold(`Tool: ${selected.name}`)}`);
  const policy = style(selected.policy, selected.policy === "auto" ? "success" : selected.policy === "ask" ? "warn" : "error");
  const rows = [
    ["policy", policy],
    ["params", selected.parameters.join(", ") || muted("(none)")],
    ["required", selected.required.join(", ") || muted("(none)")],
    ["description", selected.description]
  ];
  for (const row of keyValueList(rows)) console.log(`  ${row}`);
  blank();
}

function printModels(state) {
  const entries = modelSelectionEntries(state);
  if (!entries.length) {
    console.log(`${warnText(icon("warn"))} model: no providers available`);
    return;
  }
  const sections = [];
  for (const name of orderedProviderNames(state.cfg)) {
    const providerEntries = entries.filter((entry) => entry.provider === name);
    if (!providerEntries.length) continue;
    const configured = Boolean(state.cfg.providers?.[name]);
    sections.push(`${name}${configured ? "" : ` ${muted("(not configured)")}`}`);
    for (const entry of providerEntries) {
      const active = state.cfg.activeProvider === entry.provider && state.cfg.activeModel === entry.model ? style(icon("bullet"), "success") : muted(icon("circle"));
      sections.push(`  ${active} ${entry.model}`);
    }
  }
  printRows("Models", sections);
}

async function chooseModel(state, rl) {
  const entries = modelSelectionEntries(state).filter((entry) => entry.configured);
  if (!input.isTTY || !rl) {
    printModels(state);
    return;
  }
  if (!entries.length) {
    console.log(`${warnText(icon("warn"))} model: no configured providers. Use /login.`);
    return;
  }
  const selected = await selectFromList({
    title: "Select model",
    items: entries,
    active: entries.find((entry) => entry.provider === state.cfg.activeProvider && entry.model === state.cfg.activeModel),
    rl,
    format: (entry) => `${entry.provider.padEnd(12)} ${entry.model}`
  });
  if (!selected) {
    console.log(`model: ${state.cfg.activeProvider || "no provider"}/${state.cfg.activeModel || "no model"}`);
    return;
  }
  selectModel(state, selected.id);
}

function selectModel(state, requested) {
  const entries = modelSelectionEntries(state);
  const configuredEntries = entries.filter((entry) => entry.configured);
  const exact = configuredEntries.find((entry) => entry.id === requested);
  const modelMatches = configuredEntries.filter((entry) => entry.model === requested);
  const selected = exact || (modelMatches.length === 1 ? modelMatches[0] : null);
  if (selected) {
    state.cfg.activeProvider = selected.provider;
    state.cfg.activeModel = selected.model;
    state.cfg.providers[selected.provider] = withProviderModels(state.cfg, selected.provider, {
      ...state.cfg.providers[selected.provider],
      model: selected.model,
      models: [...providerModelList(state.cfg, selected.provider), selected.model]
    });
    saveConfig(state.cfg);
    console.log(`${successText(icon("check"))} ${muted("model:")} ${selected.provider}/${infoText(selected.model)}`);
    return;
  }
  if (modelMatches.length > 1) {
    console.log(`${warnText(icon("warn"))} model: '${requested}' exists in multiple providers. Use provider/model.`);
    return;
  }
  if (!state.cfg.activeProvider || !state.cfg.providers[state.cfg.activeProvider]) {
    console.log(`${warnText(icon("warn"))} model: no configured provider. Use /login.`);
    return;
  }
  state.cfg.activeModel = requested;
  state.cfg.providers[state.cfg.activeProvider] = withProviderModels(state.cfg, state.cfg.activeProvider, {
    ...state.cfg.providers[state.cfg.activeProvider],
    model: requested,
    models: [...providerModelList(state.cfg, state.cfg.activeProvider), requested]
  });
  saveConfig(state.cfg);
  console.log(`${successText(icon("check"))} ${muted("model:")} ${state.cfg.activeProvider}/${infoText(requested)}`);
}

function modelSelectionEntries(state) {
  const rows = [];
  for (const provider of orderedProviderNames(state.cfg)) {
    const configured = Boolean(state.cfg.providers?.[provider]);
    const models = providerModelList(state.cfg, provider);
    for (const model of models) {
      rows.push({
        id: `${provider}/${model}`,
        provider,
        model,
        configured
      });
    }
  }
  return rows;
}

function orderedProviderNames(cfg) {
  const known = providerNames();
  const configured = Object.keys(cfg.providers || {}).filter((name) => known.includes(name));
  const active = cfg.activeProvider && known.includes(cfg.activeProvider) ? [cfg.activeProvider] : [];
  return [...new Set([...active, ...configured, ...known])];
}

async function handleModels(args, state) {
  if (args[0] !== "sync") {
    printModels(state);
    return;
  }
  if (args[1] === "all") {
    const names = Object.keys(state.cfg.providers || {});
    if (!names.length) {
      console.log(`${warnText(icon("warn"))} models: no configured providers`);
      return;
    }
    console.log(`  ${muted(icon("arrow"))} syncing all providers...`);
    const results = await syncConfiguredProviderModels(state.cfg, names);
    saveConfig(state.cfg);
    for (const result of results) {
      if (result.ok) {
        console.log(`${successText(icon("check"))} ${muted("models:")} ${result.provider} ${faint("synced")} ${result.remoteCount} ${faint("remote (")}${result.totalCount}${faint(" total)")}`);
      } else {
        console.log(`${errorText(icon("cross"))} ${muted("models:")} ${result.provider} ${faint("failed:")} ${result.error || "sync failed"}`);
      }
    }
    return;
  }
  if (!state.cfg.activeProvider) {
    console.log(`${warnText(icon("warn"))} models: no active provider`);
    return;
  }
  try {
    console.log(`  ${muted(icon("arrow"))} syncing models...`);
    const result = await syncProviderModels(state.cfg, state.cfg.activeProvider);
    saveConfig(state.cfg);
    console.log(`${successText(icon("check"))} ${muted("models:")} ${faint("synced")} ${result.remoteCount} ${faint("remote models")}`);
  } catch (error) {
    console.log(`${errorText(icon("cross"))} ${muted("models:")} ${error.message}`);
  }
}

function printGoals() {
  const all = Object.entries(loadState().goals || {});
  const goals = all.slice(-10).reverse();
  printRows("Goals", goals.map(([id, item]) => `${muted(id)}  ${item.status || ""}  ${truncate(item.text || "", 60)}`), { empty: "(no goals yet — start one with a prompt)" });
  printMoreFooter(all.length, goals.length);
}

function handleGoal(args) {
  const [action = "status", idOrText, ...rest] = args;
  const saved = loadState();
  if (action === "create") {
    const text = [idOrText, ...rest].filter(Boolean).join(" ").trim();
    if (!text) {
      console.log(`${warnText(icon("warn"))} Usage: /goal create <goal text>`);
      return;
    }
    const id = `goal_${Date.now()}`;
    saved.goals[id] = { text, status: "created", createdAt: new Date().toISOString(), sessions: [] };
    saveState(saved);
    console.log(`${successText(icon("check"))} ${muted("goal:")} ${id} ${faint("created")}`);
    return;
  }
  if (action === "status") {
    if (idOrText) {
      const goal = saved.goals?.[idOrText];
      if (!goal) console.log(`${warnText(icon("warn"))} goal: no goal ${idOrText}`);
      else printRows(`Goal ${idOrText}`, [`status  ${goal.status || ""}`, `text    ${goal.text || ""}`, `started ${goal.startedAt || ""}`, `done    ${goal.finishedAt || ""}`]);
      return;
    }
    printGoals();
    return;
  }
  if (action === "stop") {
    const id = idOrText;
    if (!id) {
      console.log(`${warnText(icon("warn"))} Usage: /goal stop <id>`);
      return;
    }
    if (!saved.goals?.[id]) {
      console.log(`${warnText(icon("warn"))} goal: no goal ${id}`);
      return;
    }
    saved.goals[id].status = "stopped";
    saved.goals[id].finishedAt = new Date().toISOString();
    saveState(saved);
    console.log(`${successText(icon("check"))} ${muted("goal:")} ${id} ${faint("stopped")}`);
    return;
  }
  console.log(`${warnText(icon("warn"))} Usage: /goal <create|status|stop>`);
}

function printMissions() {
  const all = Object.entries(loadState().missions || {});
  const missions = all.slice(-10).reverse();
  printRows("Missions", missions.map(([id, item]) => `${muted(id)}  ${item.status || ""}  ${truncate(item.name || "", 60)}`), { empty: "(no missions yet — run one with /mission run <file>)" });
  printMoreFooter(all.length, missions.length);
}

function handleMemory(args) {
  const action = args[0] || "list";
  if (action === "add") {
    const text = args.slice(1).join(" ").trim();
    if (!text) console.log(`${warnText(icon("warn"))} Usage: /memory add <note>`);
    else console.log(`${successText(icon("check"))} ${muted("memory:")} ${faint("added")} ${addMemory(text).id}`);
    return;
  }
  if (action === "remove") {
    const id = args[1];
    if (!id) console.log(`${warnText(icon("warn"))} Usage: /memory remove <id>`);
    else console.log(removeMemory(id) ? `${successText(icon("check"))} ${muted("memory: removed")}` : `${warnText(icon("warn"))} memory: not found`);
    return;
  }
  const query = args.join(" ");
  const notes = searchMemory(query);
  printRows("Memory", notes.map((note) => `${muted(note.id)}  ${note.text}`));
}

function handleTodo(args, state) {
  const action = args[0] || "list";
  try {
    if (action === "list") {
      printRows("Todos", formatTodoList(listTodos(state.cwd)).split("\n").filter(Boolean));
      return;
    }
    if (action === "add") {
      const text = args.slice(1).join(" ").trim();
      if (!text) console.log(`${warnText(icon("warn"))} Usage: /todo add <text>`);
      else console.log(runTodoAction(state.cwd, "add", { text }));
      return;
    }
    if (action === "complete") {
      const id = args[1];
      if (!id) console.log(`${warnText(icon("warn"))} Usage: /todo complete <id>`);
      else console.log(runTodoAction(state.cwd, "complete", { id }));
      return;
    }
    if (action === "clear") {
      console.log(runTodoAction(state.cwd, "clear_completed", {}));
      return;
    }
    console.log(`${warnText(icon("warn"))} Usage: /todo <list|add|complete|clear>`);
  } catch (error) {
    console.log(errorText(`${icon("cross")}  ${error.message}`));
  }
}

async function handleMission(args, state, rl) {
  const [action, file] = args;
  if (action === "report" || action === "status") {
    const id = file;
    if (!id) {
      console.log(`${warnText(icon("warn"))} Usage: /mission ${action} <id>`);
      return;
    }
    const mission = loadState().missions?.[id];
    if (!mission) {
      console.log(`${warnText(icon("warn"))} mission: no mission ${id}`);
      return;
    }
    console.log(formatMissionReport(id, mission));
    return;
  }
  if (!["dry-run", "run"].includes(action) || !file) {
    console.log(`${warnText(icon("warn"))} Usage: /mission <dry-run|run|report|status> <file|id>`);
    return;
  }
  if (action === "dry-run") {
    console.log(`${brand(icon("chevronRight"))} ${bold("Mission plan")}`);
    console.log(formatMissionPlan(loadMission(file), state.cfg));
    return;
  }
  console.log(`  ${muted(icon("arrow"))} mission: running ${faint(file)}`);
  try {
    const result = await withAgentAbort(async (signal) => runMission({
      cfg: state.cfg,
      cwd: state.cwd,
      file,
      includeContext: state.includeContext,
      skills: state.skills,
      confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
      signal,
      onEvent: state.progress
        ? createAgentProgress({
          maxSteps: resolveAgentMaxSteps(state.cfg),
          style: "grok",
          quietModelTurns: true,
          onLine: (text) => console.log(text)
        })
        : null
    }), {
      onCancel: () => {
        blank();
        console.log(warnText(`  ${icon("warn")} Cancelling mission… (Ctrl+C again to exit)`));
      }
    });
    console.log(`${successText(icon("check"))} ${muted("mission:")} ${result.missionId} ${faint("completed")}`);
    for (const step of result.outputs) console.log(`\n${brand(icon("chevronRight"))} ${bold(`step ${step.index}`)}\n${step.output}`);
  } catch (error) {
    if (error instanceof AgentCancelledError) {
      console.log(warnText(`${icon("warn")} mission cancelled.`));
      return;
    }
    blank();
    const errLines = errorPanel({
      title: "Mission Error",
      message: error.message,
      code: error.code || error.status || null,
      width: tuiWidth()
    }).lines;
    if (errLines) emitLines(errLines, { tty: output.isTTY });
    else console.log(errorText(`${icon("cross")} ${error.message}`));
    blank();
  }
}

function formatMissionReport(id, mission) {
  const lines = [
    "",
    `${brand(icon("chevronRight"))} ${bold(`Mission ${id}`)}`,
    `name: ${mission.name || ""}`,
    `status: ${mission.status || ""}`,
    `startedAt: ${mission.startedAt || ""}`,
    `finishedAt: ${mission.finishedAt || ""}`,
    "steps:"
  ];
  for (const step of mission.steps || []) {
    lines.push(`  ${step.index}. ${step.status || ""} ${step.prompt || ""}`.trimEnd());
    if (step.error) lines.push(`     error: ${step.error}`);
  }
  return `${lines.join("\n")}\n`;
}

function printHooks(state) {
  const hooks = loadHookConfig(state.cfg, state.cwd);
  const rows = [];
  for (const [event, handlers] of Object.entries(hooks)) {
    if (!Array.isArray(handlers) || !handlers.length) continue;
    for (const handler of handlers) {
      const command = typeof handler === "string" ? handler : handler?.command;
      if (!command) continue;
      rows.push({ event, command: truncate(command, 72) });
    }
  }
  if (!rows.length) {
    printRows("Hooks", [
      "No hook handlers configured.",
      `Global: ${path.join(azyHome(), "hooks.json")}`,
      `Project: ${path.join(state.cwd, ".azycode", "hooks.json")}`
    ]);
    return;
  }
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Hooks")}`);
  for (const line of renderTable(rows, [
    { key: "event", label: "event" },
    { key: "command", label: "command" }
  ])) console.log(`  ${line}`);
  blank();
}

function printCustomCommands(state) {
  const commands = loadCustomCommands(state.cwd);
  if (!commands.length) {
    printRows("Custom commands", [
      "No custom commands found.",
      `Global: ${path.join(azyHome(), "commands")}`,
      `Project: ${path.join(state.cwd, ".azycode", "commands")}`
    ]);
    return;
  }
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Custom commands")}`);
  const width = commands.reduce((max, item) => Math.max(max, `/${item.name}`.length), 0);
  for (const item of commands) {
    const summary = item.description ? muted(item.description) : muted("(no description)");
    console.log(`  ${`/${item.name}`.padEnd(width)}  ${summary}`);
  }
  blank();
}

function printAgents(state) {
  const agents = Object.entries(state.cfg.subagents || {});
  printRows("Subagents", agents.map(([name, item]) => `${muted(name)}  ${item.reasoning || "medium"}  ${item.model || muted("(active model)")}  ${truncate(item.description || "", 60)}`));
}

function printProviders(state) {
  const rows = providerNames().map((name) => {
    const preset = providerPreset(name);
    const configured = Boolean(state.cfg.providers?.[name]);
    const active = state.cfg.activeProvider === name ? style(icon("bullet"), "success") : muted(icon("circle"));
    const model = state.cfg.providers?.[name]?.model || preset.defaultModel || "";
    const modelCount = configured ? providerModelList(state.cfg, name).length : (preset.models || []).length;
    const configLabel = configured ? successText("configured") : muted("not configured");
    return { active, name, configLabel, modelCount, model };
  });
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Providers")}`);
  for (const line of renderTable(rows, [
    { key: "active", label: "" },
    { key: "name", label: "name" },
    { key: "configLabel", label: "status" },
    { key: "modelCount", label: "models" },
    { key: "model", label: "default" }
  ])) console.log(`  ${line}`);
  console.log(`  ${muted(icon("sparkle"))} Use /model to choose provider and model together.`);
  blank();
}

function printCredentials(state) {
  const names = Object.keys(state.cfg.providers || {});
  if (!names.length) {
    printRows("Credentials", ["No providers configured. Use /login."]);
    return;
  }
  const rows = names.map((name) => {
    const saved = state.cfg.providers[name] || {};
    const diag = providerDiagnostics(state.cfg, name);
    const active = state.cfg.activeProvider === name ? style(icon("bullet"), "success") : muted(icon("circle"));
    const source = saved.apiKey ? `config:${maskSecret(saved.apiKey)}` : `env:${diag.apiKeySource}`;
    const keyStatus = diag.hasApiKey ? source : "missing";
    return { active, name, keyStatus, model: diag.model };
  });
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Credentials")}`);
  for (const line of renderTable(rows, [
    { key: "active", label: "" },
    { key: "name", label: "name" },
    { key: "keyStatus", label: "key" },
    { key: "model", label: "model" }
  ])) console.log(`  ${line}`);
  blank();
}

function printKeys() {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Keyboard")}`);
  const rows = [
    { key: "Tab", summary: "rotate reasoning effort" },
    { key: "Shift+Tab", summary: "rotate mode" },
    { key: "Ctrl+C", summary: "cancel/exit" },
    { key: "Ctrl+D", summary: "submit multiline prompt in command mode" }
  ];
  for (const line of renderTable(rows, [
    { key: "key", label: "key" },
    { key: "summary", label: "action" }
  ])) console.log(`  ${line}`);
  blank();
}

async function chooseConfiguredProvider(state, rl) {
  const names = Object.keys(state.cfg.providers || {});
  if (!names.length) {
    console.log(`${warnText(icon("warn"))} provider: none configured. Use /login.`);
    return;
  }
  const selected = await selectFromList({
    title: "Switch provider",
    items: names,
    active: state.cfg.activeProvider,
    rl,
    format: (name) => `${name}  ${state.cfg.providers[name]?.model || ""}`
  });
  if (!selected) {
    console.log(`provider: ${state.cfg.activeProvider || "none"}`);
    return;
  }
  state.cfg.activeProvider = selected;
  state.cfg.activeModel = state.cfg.providers[selected].model;
  saveConfig(state.cfg);
  console.log(`${successText(icon("check"))} ${muted("provider:")} ${selected}/${state.cfg.activeModel}`);
}

export async function loginProvider(state, rl) {
  if (!rl) {
    console.log(`${warnText(icon("warn"))} Interactive login requires a terminal. Run: azycode login <provider>`);
    return;
  }
  const names = providerNames();
  blank();
  const name = input.isTTY
    ? await selectFromList({
      title: "Connect provider",
      items: names,
      active: state.cfg.activeProvider,
      rl,
      format: (item) => `${item.padEnd(12)} ${providerPreset(item).label}`
    })
    : names[Number((await rl.question("Choose provider: ")).trim()) - 1];
  if (!name) {
    console.log(`${muted(icon("chevron"))} login: cancelled`);
    return;
  }
  const preset = providerPreset(name);
  const apiKey = (await readSecret(`${name} API key: `, rl)).trim();
  if (!apiKey) {
    console.log(`${warnText(icon("warn"))} login: API key is required`);
    return;
  }
  let baseUrl = preset.baseUrl;
  let model = preset.defaultModel;
  if (name === "byok") {
    baseUrl = (await rl.question("Base URL: ")).trim();
    model = (await rl.question("Default model: ")).trim();
    if (!baseUrl || !model) {
      console.log(`${warnText(icon("warn"))} login: BYOK requires base URL and model`);
      return;
    }
  }
  state.cfg.providers[name] = withProviderModels(state.cfg, name, { ...(state.cfg.providers[name] || {}), baseUrl, model, apiKey });
  state.cfg.activeProvider = name;
  state.cfg.activeModel = model;
  saveConfig(state.cfg);
  console.log(`${successText(icon("check"))} ${muted("connected:")} ${name}/${infoText(model)}`);
  console.log(`  ${muted("endpoint:")} ${baseUrl || muted("(custom)")}`);
  console.log(`  ${muted(icon("sparkle"))} next: type a task, or use /status to inspect the active setup`);
}

async function readSecret(label, rl) {
  if (!input.isTTY) return rl.question(label);
  // ponytail: feature-detect stty; on systems without it (Windows) fall back to
  // plain readline input instead of crashing /login with an unguarded throw.
  let sttyAvailable = false;
  try {
    execFileSync("stty", ["--version"], { stdio: "ignore" });
    sttyAvailable = true;
  } catch {
    sttyAvailable = false;
  }
  if (!sttyAvailable) return rl.question(label);
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    return await rl.question(label);
  } finally {
    try { execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] }); }
    catch { /* echo may already be on; best-effort */ }
    output.write("\n");
  }
}

async function selectFromList({ title, items, active = null, rl, format = (item) => item }) {
  if (!items.length) return null;
  if (!input.isTTY || !rl) {
    console.log(`${brand(icon("chevronRight"))} ${bold(title)}`);
    for (const [index, item] of items.entries()) console.log(`  ${muted(`${index + 1}.`)} ${format(item)}`);
    const raw = (await rl.question("Choose: ")).trim();
    return items[Number(raw) - 1] || (items.includes(raw) ? raw : null);
  }

  let index = Math.max(0, items.indexOf(active));
  let renderedLines = 0;
  const wasRaw = Boolean(input.isRaw);
  rl.pause();
  input.setRawMode?.(true);
  input.resume();
  const render = () => {
    if (renderedLines) {
      moveCursor(output, 0, -renderedLines);
      for (let line = 0; line < renderedLines; line += 1) {
        clearLine(output, 0);
        if (line < renderedLines - 1) moveCursor(output, 0, 1);
      }
      moveCursor(output, 0, -(renderedLines - 1));
    }
    const titleLine = `${brand(icon("chevronRight"))} ${bold(title)}`;
    const hintLine = muted(`  ${icon("arrowUp")}/${icon("arrowDown")} or j/k  ·  Enter select  ·  Esc cancel`);
    const lines = [
      titleLine,
      hintLine,
      ...items.map((item, itemIndex) => {
        const marker = itemIndex === index ? style(icon("chevron"), "brand") : muted(icon("circle"));
        return `  ${marker} ${format(item)}`;
      })
    ];
    output.write(`${lines.join("\n")}\n`);
    renderedLines = lines.length;
  };

  return new Promise((resolve) => {
    const cleanup = (value) => {
      input.off("keypress", onKeypress);
      input.setRawMode?.(wasRaw);
      rl.resume();
      rl.write(null, { ctrl: true, name: "u" });
      clearLine(output, 0);
      cursorTo(output, 0);
      output.write("\n");
      resolve(value);
    };
    const onKeypress = (_, key) => {
      if (key?.name === "up" || key?.name === "k") {
        index = (index - 1 + items.length) % items.length;
        render();
      } else if (key?.name === "down" || key?.name === "j") {
        index = (index + 1) % items.length;
        render();
      } else if (key?.name === "return") {
        cleanup(items[index]);
      } else if (key?.name === "escape" || (key?.ctrl && key?.name === "c")) {
        cleanup(null);
      }
    };
    input.on("keypress", onKeypress);
    render();
  });
}

function printRows(label, rows, { empty = null } = {}) {
  blank();
  const body = rows.length
    ? rows.map((row) => `${muted(icon("bullet"))} ${row}`)
    : [`${muted(icon("circle"))} ${empty || "(none)"}`];
  for (const line of listPanel(label.toLowerCase(), body, { width: tuiWidth() })) {
    console.log(line);
  }
  blank();
}
