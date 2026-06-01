import fs from "node:fs";
import path from "node:path";
import { clearLine, cursorTo, emitKeypressEvents } from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { execFileSync } from "node:child_process";
import { runAgent } from "./agent.js";
import { applyPermissionProfile, loadConfig, loadState, saveConfig, MODES, REASONING_LEVELS, normalizeMode, rotateMode, rotateReasoning } from "./config.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { gitGuard } from "./guard.js";
import { style } from "./ui.js";
import { providerDiagnostics, providerNames, providerPreset } from "./providers.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];
const MAX_CONVERSATION_MESSAGES = 80;
const TUI_COMMANDS = [
  "help", "status", "dashboard", "sessions", "tools", "goals", "missions", "mission",
  "memory", "agents", "agent", "providers", "provider", "login", "mode", "reasoning",
  "model", "profile", "context", "progress", "review", "new", "compact", "clear", "exit", "quit"
];

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
  const onKeypress = (_, key) => applyShortcut(key, state, { rl });
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
  const width = Math.max(56, Math.min(output.columns || 88, 96));
  const rule = "─".repeat(width);
  console.log(style("azycode", "bold"));
  console.log(style(rule, "cyan"));
  console.log(formatHeaderRow("workspace", repo, width));
  console.log(formatHeaderRow("model", `${provider}/${model}`, width));
  console.log(formatHeaderRow("session", `${state.mode}  •  reasoning ${state.cfg.reasoning}  •  profile ${state.cfg.permissionProfile || "normal"}`, width));
  console.log(formatHeaderRow("shortcuts", "type a task  /help commands  Tab reasoning  Shift+Tab mode", width));
  console.log(style(rule, "cyan"));
  console.log("");
}

function formatHeaderRow(label, value, width) {
  const labelText = label.padEnd(10);
  const available = Math.max(12, width - labelText.length - 1);
  return `${style(labelText, "dim")} ${clipText(value, available)}`;
}

function clipText(value, max) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1)}…`;
}

function promptLabel(state, { styled = true } = {}) {
  const agent = state.subagent ? ` | @${state.subagent.name}` : "";
  const label = `[${state.mode} | ${state.cfg.reasoning}${agent}]`;
  if (!styled) return `${label} > `;
  return `${style(label, "dim")} ${style(">", "cyan")} `;
}

export function applyShortcut(key, state, options = {}) {
  if (key?.name !== "tab") return;
  if (state.acceptingInput === false && options.force !== true) return;
  if (options.rl?.line?.startsWith("/")) return;
  const persist = options.persist !== false;
  const notify = options.notify || ((message) => redrawPrompt(options.rl, state, message));
  if (key.shift) {
    state.mode = rotateMode(state.mode);
    state.cfg.mode = state.mode;
    if (persist) saveConfig(state.cfg);
    notify(`mode: ${state.mode}`);
  } else {
    state.cfg.reasoning = rotateReasoning(state.cfg.reasoning);
    if (persist) saveConfig(state.cfg);
    notify(`reasoning: ${state.cfg.reasoning}`);
  }
}

function redrawPrompt(rl, state, message) {
  if (!rl || !output.isTTY) {
    if (message) console.log(message);
    return;
  }
  const line = rl.line || "";
  const cursor = rl.cursor ?? line.length;
  clearLine(output, 0);
  cursorTo(output, 0);
  output.write(`${promptLabel(state)}${line}`);
  cursorTo(output, promptLabel(state, { styled: false }).length + cursor);
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
  if (command === "memory") return ["add", "remove", "list"];
  if (command === "mission" && fixedArgs.length === 0) return ["dry-run", "run"];
  return [];
}

async function askAgent(prompt, state, rl = null) {
  if (!state.cfg.activeProvider) {
    console.log(style("No provider configured. Run `azycode login <provider>` in another terminal, then restart.", "yellow"));
    console.log("");
    return;
  }
  console.log(style("working...", "dim"));
  try {
    const result = await runAgent({
      cfg: state.cfg,
      cwd: state.cwd,
      prompt,
      mode: state.mode,
      includeContext: state.includeContext,
      onEvent: state.progress ? progressLine : null,
      conversation: state.conversation,
      returnSession: true,
      confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
      subagent: state.subagent
    });
    state.conversation = trimConversation(result.messages.filter((message) => message.role !== "system"));
    console.log("");
    console.log(style("assistant", "cyan"));
    console.log(result.content);
    console.log("");
  } catch (error) {
    console.log(style(`error: ${error.message}`, "red"));
    console.log("");
  }
}

async function confirmInTui(rl, question) {
  const answer = (await rl.question(`${question} [y/n] (n): `)).trim().toLowerCase();
  return answer === "y" || answer === "yes" || answer === "evet" || answer === "e";
}

function progressLine(event) {
  if (event.type === "model_start") console.log(style(`  model step ${event.step}`, "dim"));
  else if (event.type === "tool_start") console.log(style(`  tool  ${event.tool}`, "dim"));
  else if (event.type === "tool_end") console.log(style(`  done  ${event.tool} (${event.durationMs}ms)`, event.ok ? "green" : "red"));
}

async function handleCommand(line, state, rl = null) {
  const [command, ...args] = line.slice(1).trim().split(/\s+/);
  if (command === "exit" || command === "quit") return "exit";
  if (command === "help") {
    printHelp();
    return;
  }
  if (command === "clear") {
    if (output.isTTY) output.write("\x1b[2J\x1b[H");
    printWelcome(state);
    return;
  }
  if (command === "new") {
    state.conversation = [];
    console.log("conversation: cleared");
    return;
  }
  if (command === "compact") {
    const before = state.conversation.length;
    state.conversation = trimConversation(state.conversation, 20);
    console.log(`conversation: ${before} -> ${state.conversation.length} messages`);
    return;
  }
  if (command === "mode") {
    const next = normalizeMode(args[0]);
    if (!MODES.includes(next)) console.log(`mode: ${MODES.join(", ")}`);
    else {
      state.mode = next;
      state.cfg.mode = next;
      saveConfig(state.cfg);
      console.log(`mode: ${next}`);
    }
    return;
  }
  if (command === "reasoning") {
    const next = args[0];
    if (!REASONING_LEVELS.includes(next)) console.log(`reasoning: ${REASONING_LEVELS.join(", ")}`);
    else {
      state.cfg.reasoning = next;
      saveConfig(state.cfg);
      console.log(`reasoning: ${next}`);
    }
    return;
  }
  if (command === "model") {
    const next = args.join(" ");
    if (!next) console.log(`model: ${state.cfg.activeModel || "no model"}`);
    else {
      state.cfg.activeModel = next;
      if (state.cfg.activeProvider && state.cfg.providers[state.cfg.activeProvider]) {
        state.cfg.providers[state.cfg.activeProvider].model = next;
      }
      saveConfig(state.cfg);
      console.log(`model: ${next}`);
    }
    return;
  }
  if (command === "providers") {
    printProviders(state);
    return;
  }
  if (command === "provider") {
    const name = args[0];
    if (!name) {
      console.log(`provider: ${state.cfg.activeProvider || "none"}`);
    } else if (!state.cfg.providers?.[name]) {
      console.log(`Provider '${name}' is not configured. Run: azycode login ${name}`);
    } else {
      state.cfg.activeProvider = name;
      state.cfg.activeModel = state.cfg.providers[name].model;
      saveConfig(state.cfg);
      console.log(`provider: ${name}/${state.cfg.activeModel}`);
    }
    return;
  }
  if (command === "profile") {
    const next = args[0];
    if (!PROFILES.includes(next)) console.log(`profile: ${PROFILES.join(", ")}`);
    else {
      state.cfg.permissionProfile = next;
      applyPermissionProfile(state.cfg);
      saveConfig(state.cfg);
      console.log(`profile: ${next}`);
    }
    return;
  }
  if (command === "context") {
    state.includeContext = !state.includeContext;
    console.log(`context: ${state.includeContext}`);
    return;
  }
  if (command === "progress") {
    state.progress = !state.progress;
    console.log(`progress: ${state.progress}`);
    return;
  }
  if (command === "review") {
    console.log(formatLocalReview(localReview(state.cwd)));
    return;
  }
  if (command === "dashboard") {
    printDashboard(state);
    return;
  }
  if (command === "sessions") {
    printSessions();
    return;
  }
  if (command === "tools") {
    printToolRuns();
    return;
  }
  if (command === "goals") {
    printGoals();
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
      console.log(`agent: ${state.subagent?.name || "off"}`);
    } else if (name === "off") {
      state.subagent = null;
      console.log("agent: off");
    } else if (!state.cfg.subagents?.[name]) {
      console.log(`No subagent '${name}'. Use /agents.`);
    } else {
      state.subagent = { name, ...state.cfg.subagents[name] };
      console.log(`agent: @${name}`);
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
  console.log(`Unknown command: /${command}. Use /help.`);
}

function printHelp() {
  console.log("");
  console.log(style("Commands", "cyan"));
  console.log("  /status                 show active model and git guard");
  console.log("  /mode <name>            plan, always-approve, goal, review");
  console.log("  /reasoning <level>      minimal, low, medium, high");
  console.log("  /model <id>             show or change the active model");
  console.log("  /providers              show available and configured providers");
  console.log("  /provider <name>        switch to a configured provider");
  console.log("  /profile <name>         normal, read-only, safe-write, full-auto");
  console.log("  /context                toggle bounded repository context");
  console.log("  /progress               toggle inline model/tool activity");
  console.log("  /review                 inspect local git changes");
  console.log("  /dashboard              show local session and automation counts");
  console.log("  /sessions               show recent agent sessions");
  console.log("  /tools                  show recent tool activity");
  console.log("  /goals                  show saved goals");
  console.log("  /missions               show saved missions");
  console.log("  /mission <action>       dry-run or run a mission file");
  console.log("  /memory [add|remove]    manage persistent notes");
  console.log("  /agents                 show available subagents");
  console.log("  /agent <name|off>       select a subagent for this conversation");
  console.log("  /new                    start a fresh conversation");
  console.log("  /compact                keep only recent conversation context");
  console.log("  /login                  choose a provider and enter its API key");
  console.log("  /clear                  clear the terminal");
  console.log("  /exit                   leave azycode");
  console.log("");
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
  console.log("");
  console.log(style("Dashboard", "cyan"));
  printKeyValues([
    ["workspace", path.basename(state.cwd)],
    ["provider", state.cfg.activeProvider || "none"],
    ["model", state.cfg.activeModel || "none"],
    ["mode", state.mode],
    ["reasoning", state.cfg.reasoning],
    ["profile", state.cfg.permissionProfile || "normal"],
    ["agent", state.subagent?.name || "off"],
    ["context", state.includeContext ? "on" : "off"],
    ["git guard", guard.ok ? `ok${guard.dirty ? " (dirty)" : ""}` : "blocked"]
  ]);
  console.log("");
  printKeyValues([
    ["sessions", Object.keys(saved.sessions || {}).length],
    ["goals", Object.keys(saved.goals || {}).length],
    ["missions", Object.keys(saved.missions || {}).length],
    ["tool runs", (saved.toolRuns || []).length],
    ["messages", state.conversation.length]
  ]);
  console.log("");
}

function printStatus(state) {
  console.log("");
  console.log(style("Status", "cyan"));
  printKeyValues([
    ["workspace", path.basename(state.cwd)],
    ["provider", state.cfg.activeProvider || "no provider"],
    ["model", state.cfg.activeModel || "no model"],
    ["mode", state.mode],
    ["reasoning", state.cfg.reasoning],
    ["profile", state.cfg.permissionProfile || "normal"],
    ["agent", state.subagent?.name || "off"],
    ["context", state.includeContext ? "on" : "off"],
    ["progress", state.progress ? "on" : "off"]
  ]);

  if (state.cfg.activeProvider) {
    try {
      const provider = providerDiagnostics(state.cfg);
      console.log("");
      console.log(style("Provider", "cyan"));
      printKeyValues([
        ["endpoint", provider.baseUrl || "(custom)"],
        ["protocol", provider.protocol],
        ["chat path", provider.chatPath],
        ["api key", provider.hasApiKey ? `configured (${provider.apiKeySource})` : `missing (${provider.apiKeySource})`]
      ]);
    } catch (error) {
      console.log(style(`provider: ${error.message}`, "yellow"));
    }
  }

  const guard = gitGuard(state.cwd, state.cfg);
  console.log("");
  console.log(style("Guard", "cyan"));
  if (guard.ok) {
    printKeyValues([
      ["status", "ok"],
      ["branch", guard.branch || "(none)"],
      ["dirty", guard.dirty ? "yes" : "no"]
    ]);
    for (const warning of guard.warnings || []) console.log(`  ${style("warning", "yellow")} ${warning}`);
  } else {
    printKeyValues([["status", "blocked"], ["reason", guard.reason]]);
  }
  console.log("");
}

function printKeyValues(rows) {
  const width = rows.reduce((max, [key]) => Math.max(max, String(key).length), 0);
  for (const [key, value] of rows) {
    console.log(`  ${style(String(key).padEnd(width), "dim")}  ${value ?? ""}`);
  }
}

function printSessions() {
  const sessions = Object.entries(loadState().sessions || {}).slice(-10).reverse();
  printRows("Sessions", sessions.map(([id, item]) => `${id}  ${item.mode || ""}  ${String(item.prompt || "").slice(0, 70)}`));
}

function printToolRuns() {
  const runs = (loadState().toolRuns || []).slice(-10).reverse();
  printRows("Tool runs", runs.map((run) => `${run.name}  ${run.ok ? "ok" : "failed"}  ${run.durationMs}ms  ${run.sessionId}`));
}

function printGoals() {
  const goals = Object.entries(loadState().goals || {}).slice(-10).reverse();
  printRows("Goals", goals.map(([id, item]) => `${id}  ${item.status || ""}  ${item.text || ""}`));
}

function printMissions() {
  const missions = Object.entries(loadState().missions || {}).slice(-10).reverse();
  printRows("Missions", missions.map(([id, item]) => `${id}  ${item.status || ""}  ${item.name || ""}`));
}

function handleMemory(args) {
  const action = args[0] || "list";
  if (action === "add") {
    const text = args.slice(1).join(" ").trim();
    if (!text) console.log("Usage: /memory add <note>");
    else console.log(`memory: added ${addMemory(text).id}`);
    return;
  }
  if (action === "remove") {
    const id = args[1];
    if (!id) console.log("Usage: /memory remove <id>");
    else console.log(removeMemory(id) ? "memory: removed" : "memory: not found");
    return;
  }
  const query = args.join(" ");
  const notes = searchMemory(query);
  printRows("Memory", notes.map((note) => `${note.id}  ${note.text}`));
}

async function handleMission(args, state, rl) {
  const [action, file] = args;
  if (!["dry-run", "run"].includes(action) || !file) {
    console.log("Usage: /mission <dry-run|run> <file>");
    return;
  }
  if (action === "dry-run") {
    console.log(formatMissionPlan(loadMission(file), state.cfg));
    return;
  }
  console.log(`mission: running ${file}`);
  const result = await runMission({
    cfg: state.cfg,
    cwd: state.cwd,
    file,
    confirmTool: rl ? (question) => confirmInTui(rl, question) : null,
    onEvent: state.progress ? progressLine : null
  });
  console.log(`mission: ${result.missionId} completed`);
  for (const step of result.outputs) console.log(`\nstep ${step.index}\n${step.output}`);
}

function printAgents(state) {
  const agents = Object.entries(state.cfg.subagents || {});
  printRows("Subagents", agents.map(([name, item]) => `${name}  ${item.reasoning || "medium"}  ${item.model || "(active model)"}  ${item.description || ""}`));
}

function printProviders(state) {
  const rows = providerNames().map((name) => {
    const preset = providerPreset(name);
    const configured = Boolean(state.cfg.providers?.[name]);
    const active = state.cfg.activeProvider === name ? "*" : " ";
    return `${active} ${name}  ${configured ? "configured" : "not configured"}  ${state.cfg.providers?.[name]?.model || preset.defaultModel || ""}`;
  });
  printRows("Providers", rows);
}

export async function loginProvider(state, rl) {
  if (!rl) {
    console.log("Interactive login requires a terminal. Run: azycode login <provider>");
    return;
  }
  const names = providerNames();
  console.log("");
  console.log(style("Connect provider", "cyan"));
  for (const [index, name] of names.entries()) {
    console.log(`  ${index + 1}. ${name.padEnd(12)} ${providerPreset(name).label}`);
  }
  const rawChoice = (await rl.question("Choose provider: ")).trim();
  const name = names[Number(rawChoice) - 1] || (names.includes(rawChoice) ? rawChoice : null);
  if (!name) {
    console.log("login: cancelled");
    return;
  }
  const preset = providerPreset(name);
  const apiKey = (await readSecret(`${name} API key: `, rl)).trim();
  if (!apiKey) {
    console.log("login: API key is required");
    return;
  }
  let baseUrl = preset.baseUrl;
  let model = preset.defaultModel;
  if (name === "byok") {
    baseUrl = (await rl.question("Base URL: ")).trim();
    model = (await rl.question("Default model: ")).trim();
    if (!baseUrl || !model) {
      console.log("login: BYOK requires base URL and model");
      return;
    }
  }
  state.cfg.providers[name] = { baseUrl, model, apiKey };
  state.cfg.activeProvider = name;
  state.cfg.activeModel = model;
  saveConfig(state.cfg);
  console.log(`connected: ${name}/${model}`);
  console.log(`endpoint: ${baseUrl || "(custom)"}`);
  console.log("next: type a task, or use /status to inspect the active setup");
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

function printRows(label, rows) {
  console.log("");
  console.log(style(label, "cyan"));
  if (!rows.length) console.log("  (none)");
  else for (const row of rows) console.log(`  ${row}`);
  console.log("");
}
