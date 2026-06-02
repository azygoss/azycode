import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { clearLine, cursorTo, emitKeypressEvents, moveCursor } from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync } from "node:child_process";
import { runAgent } from "./agent.js";
import { LlmClient } from "./llm.js";
import { applyPermissionProfile, azyHome, configPath, loadConfig, loadState, maskSecret, saveConfig, saveState, MODES, REASONING_LEVELS, normalizeMode, rotateMode, rotateReasoning } from "./config.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { gitGuard } from "./guard.js";
import {
  accent,
  badge,
  blank,
  bold,
  box,
  brand,
  code,
  dim,
  error as errorText,
  faint,
  header as renderHeader,
  icon,
  info as infoText,
  keyValueList,
  kv,
  list,
  muted,
  paint,
  padEnd,
  panel,
  pill,
  prettyMs,
  promptStatus,
  renderTable,
  rule,
  section as sectionText,
  spinnerFrame,
  startSpinner,
  statusDot,
  stopSpinner,
  stripAnsi,
  style,
  subtle,
  success as successText,
  tag,
  title as titleText,
  truncate,
  tree,
  visibleLength,
  warn as warnText
} from "./ui.js";
import { providerDiagnostics, providerModelList, providerNames, providerPreset, withProviderModels } from "./providers.js";
import { syncConfiguredProviderModels, syncProviderModels } from "./model-sync.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";
import { contextPack, formatContextPack } from "./context.js";
import { toolCatalog } from "./tools.js";
import { createAgentProgress, hasActiveProvider, runtimeSnapshot } from "./harness.js";
import { createPromptSession, normalizeTabKey } from "./terminal-input.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];
const MAX_CONVERSATION_MESSAGES = 80;
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TUI_COMMANDS = [
  "help", "status", "health", "doctor", "dashboard", "sessions", "tools", "goals", "missions", "mission",
  "session", "policy", "tool", "memory", "agents", "agent", "providers", "provider", "login", "mode", "reasoning",
  "model", "models", "profile", "credentials", "keys", "workspace", "context", "progress", "review", "new", "compact", "clear", "exit", "quit"
];
const TOOL_POLICY_MODES = ["auto", "ask", "deny"];

const AGENT_BORDER = "rounded";
const PANEL_WIDTH = (output.columns && output.columns >= 60 ? Math.min(output.columns - 4, 96) : 80);

export async function launchTui({ cwd = process.cwd() } = {}) {
  const cfg = loadConfig();
  const state = {
    cfg,
    cwd,
    mode: normalizeMode(cfg.mode),
    includeContext: false,
    progress: true,
    conversation: [],
    subagent: null
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
  emitKeypressEvents(input, rl);

  const onKeypress = (_, key) => handleKeypress(key, state, rl, promptSession);
  input.on("keypress", onKeypress);
  try {
    while (true) {
      state.acceptingInput = true;
      const line = (await rl.question(promptLabel(state))).trim();
      state.acceptingInput = false;
      if (!line) continue;
      if (line.startsWith("/")) {
        const done = await handleCommand(line, state, rl);
        if (done === "exit") break;
      } else {
        await askAgent(line, state, rl);
      }
    }
  } finally {
    input.off("keypress", onKeypress);
    rl.close();
  }
}

function printWelcome(state) {
  const repo = path.basename(state.cwd);
  const provider = state.cfg.activeProvider || "no provider";
  const model = state.cfg.activeModel || "no model";
  const guard = gitGuard(state.cwd, state.cfg);
  const guardLabel = guard.ok ? "ok" : "blocked";
  const guardStyle = guard.ok ? "success" : "error";
  blank();

  // Pick a banner width that comfortably fits the longest line of content while
  // staying within typical TTY widths.
  const W = 96;
  const header = `${bold("azycode")}  ${muted("v0.1")}  ${muted("·")}  ${muted("interactive coding harness")}`;
  console.log(padEnd(header, W));
  console.log(rule(W, { label: "ready", labelColor: "info" }));

  const segments = [
    ["workspace", repo],
    ["model", `${provider}/${model}`],
    ["session", `${state.mode} · reasoning ${state.cfg.reasoning} · profile ${state.cfg.permissionProfile || "normal"}`],
    ["guard", `${statusDot(guardLabel)} ${style(guardLabel, guardStyle)}`]
  ];
  for (const [label, value] of segments) {
    // padEnd from ui.js accounts for ANSI escape codes, so labels align cleanly.
    console.log(`  ${padEnd(muted(label), 16)}${value}`);
  }

  console.log(rule(W, { char: "·", color: "subtle" }));

  const shortcuts = [
    `${muted("type a task")}  ${muted("·")}  ${muted("/help commands")}  ${muted("·")}  ${muted("Tab reasoning")}  ${muted("·")}  ${muted("Shift+Tab mode")}`,
    `${muted("shortcuts:")}  ${subtle("/login")} ${muted("connect")}  ${subtle("/status")} ${muted("inspect")}  ${subtle("/model")} ${muted("switch")}`
  ];
  for (const line of shortcuts) {
    console.log(`  ${padEnd(line, W - 2)}`);
  }
  if (!hasActiveProvider(state.cfg)) {
    console.log(`  ${warnText(icon("warn"))} ${muted("No provider connected — type")} ${subtle("/login")} ${muted("to start.")}`);
  }
  blank();
}

export function promptLabel(state, { styled = true } = {}) {
  // Prompt focuses on mode/reasoning/agent — guard status lives in the welcome
  // banner and /status so the prompt stays compact and scannable.
  const status = promptStatus({
    mode: state.mode,
    reasoning: state.cfg.reasoning,
    agent: state.subagent?.name,
    profile: state.cfg.permissionProfile
  });
  const cursor = styled ? style(icon("chevron"), "brand") : "›";
  if (!styled) return `${status}  ${cursor} `;
  return `${status}  ${cursor} `;
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

function handleKeypress(key, state, rl, promptSession) {
  if (promptSession?.handleTabKeypress(key, rl, (tabKey) => {
    applyShortcut(tabKey, state, { rl, promptSession });
  })) return;
  if (key?.sequence !== "/") {
    if (rl.line !== "/") state.commandPaletteShown = false;
    return;
  }
  setTimeout(() => {
    if (rl.line !== "/" || state.commandPaletteShown) return;
    state.commandPaletteShown = true;
    output.write("\n");
    printCommandPalette(state);
    promptSession?.refreshPrompt(rl);
  }, 0);
}

export { findUnderlyingInterface } from "./terminal-input.js";

export function stripTrailingTab(rl, state) {
  const session = createPromptSession({
    output,
    getPrompt: () => promptLabel(state, { styled: false })
  });
  session.stripTrailingTab(rl);
}

function paintInlineOverlay(rl, state, message) {
  const line = rl?.line || "";
  const cursor = rl?.cursor ?? line.length;
  const label = `${muted(message)}`;
  clearLine(output, 0);
  cursorTo(output, 0);
  output.write(label);
  output.write("  ");
  output.write(line);
  cursorTo(output, visibleLength(label) + 2 + cursor);
}

export function completeTuiInput(line, state) {
  if (!line.startsWith("/")) return [[], line];
  const body = line.slice(1);
  const hasTrailingSpace = /\s$/.test(line);
  const parts = body.split(/\s+/).filter(Boolean);
  const command = parts[0] || "";
  if (parts.length === 0 || (parts.length === 1 && !hasTrailingSpace)) {
    const completions = TUI_COMMANDS.map((item) => `/${item}`).filter((item) => item.startsWith(`/${command}`));
    return [completions.length ? completions : TUI_COMMANDS.map((item) => `/${item}`), line];
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
  if (command === "model" && fixedArgs.length === 0) return ["sync", ...modelSelectionEntries(state).map((entry) => entry.id)];
  if (command === "model" && fixedArgs[0] === "sync") return ["all"];
  if (command === "models" && fixedArgs.length === 0) return ["sync"];
  if (command === "models" && fixedArgs[0] === "sync") return ["all"];
  if (command === "tool" && fixedArgs.length === 0) return Object.keys(state.cfg.toolPolicy || {});
  if (command === "tool" && fixedArgs.length === 1) return TOOL_POLICY_MODES;
  if (command === "mission" && fixedArgs.length === 0) return ["dry-run", "run", "report", "status"];
  return [];
}

async function askAgent(prompt, state, rl = null) {
  if (!hasActiveProvider(state.cfg)) {
    blank();
    for (const line of box([
      `${warnText(icon("warn"))} ${bold("Provider required")}`,
      "",
      `${muted("Connect a model provider before running tasks.")}`,
      `${muted("In this workspace, type")} ${subtle("/login")} ${muted("and follow the prompts.")}`
    ], { width: PANEL_WIDTH, frame: AGENT_BORDER, title: "setup" })) {
      console.log(line);
    }
    blank();
    return;
  }
  const spinner = state.progress ? startSpinner({ label: `thinking  ${truncate(prompt, 36)}`, stream: output, isTTY: output.isTTY }) : null;
  const onEvent = state.progress
    ? createAgentProgress({
      spinner,
      log: !spinner,
      onLine: (text) => console.log(muted(`  ${icon("chevronRight")} ${text}`))
    })
    : null;
  try {
    const result = await runAgent({
      cfg: state.cfg,
      cwd: state.cwd,
      prompt,
      mode: state.mode,
      includeContext: state.includeContext,
      onEvent,
      conversation: state.conversation,
      returnSession: true,
      confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
      subagent: state.subagent
    });
    state.conversation = trimConversation(result.messages.filter((message) => message.role !== "system"));
    if (spinner) stopSpinner({ finalLabel: `done  ${truncate(prompt, 36)}` });
    blank();
    console.log(`${brand(icon("spike"))} ${bold(brand("assistant"))}`);
    console.log(renderAssistantContent(result.content));
    blank();
  } catch (error) {
    if (spinner) stopSpinner({ finalStyle: "error", finalLabel: `error  ${truncate(prompt, 36)}` });
    console.log(errorText(`${icon("cross")}  ${error.message}`));
    blank();
  }
}

function renderAssistantContent(content) {
  const text = String(content ?? "").trim();
  if (!text) return muted("(no response)");
  const lines = text.split(/\n/);
  return lines.map((line) => `  ${line}`).join("\n");
}

async function confirmInTui(rl, question) {
  const answer = (await rl.question(`${warnText(icon("warn") + "  " + question)} ${muted("[y/n]")} (n): `)).trim().toLowerCase();
  return answer === "y" || answer === "yes" || answer === "evet" || answer === "e";
}

async function handleCommand(line, state, rl = null) {
  const [command, ...args] = line.slice(1).trim().split(/\s+/);
  if (!command) {
    printCommandPalette(state);
    return;
  }
  if (command === "exit" || command === "quit") return "exit";
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
    state.conversation = trimConversation(state.conversation, 20);
    console.log(`${muted(icon("chevron"))} conversation: ${before} -> ${state.conversation.length} messages`);
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
      const pack = contextPack(state.cwd, { maxFiles: 20, maxBytes: 40000 });
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
  if (command === "review") {
    printReview(state);
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
  console.log(`${warnText(icon("warn"))} Unknown command: /${command}. Use /help.`);
}

function modeColor(mode) {
  if (mode === "plan") return "info";
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

function printHelpGroups() {
  const groups = [
    { title: "Status", items: [
      ["/status", "active model, provider, guard"],
      ["/health", "provider connectivity"],
      ["/doctor", "local binary and config paths"],
      ["/dashboard", "local overview"],
      ["/workspace", "cwd, config, git, guard"]
    ]},
    { title: "Providers", items: [
      ["/login", "connect a provider"],
      ["/provider", "switch configured provider"],
      ["/model", "all models grouped by provider"],
      ["/providers", "show provider presets"],
      ["/credentials", "masked provider key sources"]
    ]},
    { title: "Run", items: [
      ["/mode", "plan, always-approve, goal, review"],
      ["/reasoning", "minimal, low, medium, high"],
      ["/profile", "permission profile"],
      ["/context", "toggle repository context"],
      ["/progress", "toggle inline activity"]
    ]},
    { title: "Review", items: [
      ["/review", "local git review"],
      ["/policy", "tool approvals"],
      ["/tool", "set tool approval mode"],
      ["/agents", "show subagents"],
      ["/agent", "select subagent"]
    ]},
    { title: "State", items: [
      ["/sessions", "recent agent sessions"],
      ["/session", "show session transcript"],
      ["/tools", "recent tool activity"],
      ["/goals", "saved goals"],
      ["/missions", "saved missions"]
    ]},
    { title: "Other", items: [
      ["/mission", "dry-run, run, report"],
      ["/memory", "manage notes"],
      ["/keys", "keyboard shortcuts"],
      ["/new", "start a fresh conversation"],
      ["/compact", "trim context"],
      ["/clear", "redraw the screen"],
      ["/exit", "leave azycode"]
    ]}
  ];
  blank();
  for (const group of groups) {
    console.log(`${brand(icon("chevronRight"))} ${bold(group.title)}`);
    const width = group.items.reduce((max, [name]) => Math.max(max, name.length), 0);
    for (const [name, summary] of group.items) {
      console.log(`  ${name.padEnd(width)}  ${muted(summary)}`);
    }
    console.log("");
  }
  console.log(`  ${muted(icon("sparkle"))} hint: type ${infoText("/")} alone to open the command palette.`);
  blank();
}

function printCommandPalette(state) {
  const groups = [
    { title: "Status", items: [
      ["/status", "active model, provider, guard"],
      ["/health", "provider connectivity"],
      ["/doctor", "local binary and config paths"],
      ["/login", "connect a provider"],
      ["/provider", "switch configured provider"],
      ["/model", "all models grouped by provider"],
      ["/providers", "show provider presets"],
      ["/credentials", "masked provider key sources"],
      ["/keys", "keyboard shortcuts"]
    ]},
    { title: "Run", items: [
      ["/mode", "set plan, always-approve, goal, review"],
      ["/reasoning", "set minimal, low, medium, high"],
      ["/policy", "show tool approvals"],
      ["/tool", "set tool approval mode"],
      ["/agents", "show subagents"],
      ["/agent", "select subagent"],
      ["/missions", "show missions"],
      ["/memory", "manage notes"],
      ["/review", "local review"]
    ]},
    { title: "State", items: [
      ["/dashboard", "local overview"],
      ["/workspace", "cwd, config, git, guard"],
      ["/session", "show session transcript"],
      ["/clear", "redraw screen"],
      ["/exit", "leave azycode"]
    ]}
  ];
  blank();
  for (const group of groups) {
    console.log(`${brand(icon("chevronRight"))} ${bold(group.title)}`);
    const width = group.items.reduce((max, [command]) => Math.max(max, command.length), 0);
    for (const [command, summary] of group.items) {
      console.log(`  ${command.padEnd(width)}  ${muted(summary)}`);
    }
    console.log("");
  }
  const provider = state.cfg.activeProvider || "no provider";
  const model = state.cfg.activeModel || "no model";
  console.log(`  ${muted("active:")} ${provider}/${model}  ${style(state.mode, modeColor(state.mode))}  ${muted("reasoning")} ${state.cfg.reasoning}`);
  blank();
}

export function trimConversation(messages, maxMessages = MAX_CONVERSATION_MESSAGES) {
  if (messages.length <= maxMessages) return messages;
  const tailStart = Math.max(0, messages.length - maxMessages);
  const userBoundary = messages.findIndex((message, index) => index >= tailStart && message.role === "user");
  return messages.slice(userBoundary === -1 ? tailStart : userBoundary);
}

function printDashboard(state) {
  const saved = loadState();
  const guard = gitGuard(state.cwd, state.cfg);
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Dashboard")}`);
  const leftRows = [
    [`${muted("workspace")}  ${path.basename(state.cwd)}`],
    [`${muted("model")}  ${state.cfg.activeProvider || muted("none")}/${state.cfg.activeModel || muted("none")}`],
    [`${muted("mode")}  ${style(state.mode, modeColor(state.mode))}`],
    [`${muted("reasoning")}  ${infoText(state.cfg.reasoning)}`],
    [`${muted("profile")}  ${state.cfg.permissionProfile ? accent(state.cfg.permissionProfile) : muted("normal")}`],
    [`${muted("agent")}  ${state.subagent?.name ? brand(`@${state.subagent.name}`) : muted("off")}`],
    [`${muted("context")}  ${state.includeContext ? successText("on") : muted("off")}`],
    [`${muted("git guard")}  ${statusDot(guard.ok ? "ok" : "blocked")} ${guard.ok ? successText("ok") : errorText("blocked")}${guard.dirty ? ` ${faint("(dirty)")}` : ""}`]
  ];
  for (const [row] of leftRows) console.log(`  ${row}`);
  blank();
  const counts = [
    ["sessions", Object.keys(saved.sessions || {}).length],
    ["goals", Object.keys(saved.goals || {}).length],
    ["missions", Object.keys(saved.missions || {}).length],
    ["tool runs", (saved.toolRuns || []).length],
    ["messages", state.conversation.length]
  ];
  for (const [label, value] of counts) {
    console.log(`  ${muted(label.padEnd(11))} ${bold(String(value))}`);
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
  const review = localReview(state.cwd);
  console.log(formatLocalReview(review));
  const actionable = review.findings.filter((item) => item.severity !== "info");
  if (!actionable.length) {
    console.log(`${successText(icon("check"))} ${muted(`review: clean (${review.files.length} files, +${review.stats.added} -${review.stats.removed})`)}`);
  }
}

function gitSummary(cwd) {
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" }).trim() || "detached";
    const dirty = execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" }).trim() ? "yes" : "no";
    return { branch, dirty };
  } catch {
    return { branch: "unknown", dirty: "unknown" };
  }
}

function printStatus(state) {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Status")}`);
  const overview = [
    ["workspace", path.basename(state.cwd)],
    ["provider", state.cfg.activeProvider || "no provider"],
    ["model", state.cfg.activeModel || "no model"],
    ["mode", style(state.mode, modeColor(state.mode))],
    ["reasoning", infoText(state.cfg.reasoning)],
    ["profile", state.cfg.permissionProfile ? accent(state.cfg.permissionProfile) : muted("normal")],
    ["agent", state.subagent?.name ? brand(`@${state.subagent.name}`) : muted("off")],
    ["context", state.includeContext ? successText("on") : muted("off")],
    ["progress", state.progress ? successText("on") : muted("off")]
  ];
  for (const row of keyValueList(overview)) console.log(`  ${row}`);

  if (state.cfg.activeProvider) {
    try {
      const provider = providerDiagnostics(state.cfg);
      blank();
      console.log(`${brand(icon("chevronRight"))} ${bold("Provider")}`);
      const rows = [
        ["endpoint", provider.baseUrl || muted("(custom)")],
        ["protocol", provider.protocol],
        ["chat path", provider.chatPath],
        ["api key", provider.hasApiKey ? successText(`configured (${muted(provider.apiKeySource)})`) : warnText(`missing (${provider.apiKeySource})`)]
      ];
      for (const row of keyValueList(rows)) console.log(`  ${row}`);
    } catch (error) {
      console.log(`  ${warnText(icon("warn"))} ${warnText(error.message)}`);
    }
  }

  const guard = gitGuard(state.cwd, state.cfg);
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold("Guard")}`);
  if (guard.ok) {
    const rows = [
      ["status", successText("ok")],
      ["branch", guard.branch || muted("(none)")],
      ["dirty", guard.dirty ? warnText("yes") : successText("no")]
    ];
    for (const row of keyValueList(rows)) console.log(`  ${row}`);
    for (const warning of guard.warnings || []) console.log(`  ${warnText(icon("warn"))} ${warning}`);
  } else {
    for (const row of keyValueList([["status", errorText("blocked")], ["reason", guard.reason]])) console.log(`  ${row}`);
  }
  blank();
}

function printSessions() {
  const sessions = Object.entries(loadState().sessions || {}).slice(-10).reverse();
  printRows("Sessions", sessions.map(([id, item]) => `${muted(id)}  ${item.mode || ""}  ${truncate(item.prompt || "", 60)}`));
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
    console.log(formatSessionTranscript(session));
  }
  blank();
}

function formatSessionTranscript(session) {
  const lines = [];
  for (const message of session.messages || []) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      lines.push(`${brand(icon("chevronRight"))} ${brand("assistant")}: ${message.content || ""}`);
      for (const call of message.tool_calls || []) {
        lines.push(`  ${muted(icon("arrow"))} ${muted(call.function?.name)} ${muted(call.function?.arguments || "{}")}`);
      }
    } else if (message.role === "tool") {
      lines.push(`  ${muted(icon("bullet"))} ${muted(`tool ${message.name || ""}`.trim())}: ${String(message.content || "").slice(0, 2000)}`);
    } else {
      lines.push(`${muted(message.role || "message")}: ${message.content || ""}`);
    }
  }
  return lines.join("\n") || muted("(empty transcript)");
}

function printToolRuns() {
  const runs = (loadState().toolRuns || []).slice(-10).reverse();
  printRows("Tool runs", runs.map((run) => `${muted(run.name)}  ${run.ok ? successText("ok") : errorText("failed")}  ${faint(prettyMs(run.durationMs))}  ${muted(run.sessionId)}`));
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
  for (const name of names) {
    try {
      const result = await new LlmClient(state.cfg, name).listModels();
      const count = Array.isArray(result) ? result.length : Object.keys(result || {}).length;
      const active = state.cfg.activeProvider === name ? style(icon("bullet"), "success") : muted(icon("circle"));
      console.log(`  ${active} ${name.padEnd(12)} ${successText("ok")} ${faint(`(${count} models)`)}`);
    } catch (error) {
      console.log(`  ${errorText(icon("cross"))} ${name.padEnd(12)} ${errorText("failed")} ${faint(`(${error.message})`)}`);
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
        console.log(`${errorText(icon("cross"))} ${muted("models:")} ${result.provider} ${faint("failed:")} ${error.message ?? result.error}`);
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
  const goals = Object.entries(loadState().goals || {}).slice(-10).reverse();
  printRows("Goals", goals.map(([id, item]) => `${muted(id)}  ${item.status || ""}  ${truncate(item.text || "", 60)}`));
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
  const missions = Object.entries(loadState().missions || {}).slice(-10).reverse();
  printRows("Missions", missions.map(([id, item]) => `${muted(id)}  ${item.status || ""}  ${truncate(item.name || "", 60)}`));
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
  const result = await runMission({
    cfg: state.cfg,
    cwd: state.cwd,
    file,
    confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
    onEvent: state.progress
      ? createAgentProgress({ log: true, onLine: (text) => console.log(muted(`  ${icon("chevronRight")} ${text}`)) })
      : null
  });
  console.log(`${successText(icon("check"))} ${muted("mission:")} ${result.missionId} ${faint("completed")}`);
  for (const step of result.outputs) console.log(`\n${brand(icon("chevronRight"))} ${bold(`step ${step.index}`)}\n${step.output}`);
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
  try {
    execFileSync("stty", ["-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    return await rl.question(label);
  } finally {
    execFileSync("stty", ["echo"], { stdio: ["inherit", "ignore", "ignore"] });
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

function printRows(label, rows) {
  blank();
  console.log(`${brand(icon("chevronRight"))} ${bold(label)}`);
  if (!rows.length) console.log(`  ${muted(icon("circle"))} (none)`);
  else for (const row of rows) console.log(`  ${row}`);
  blank();
}
