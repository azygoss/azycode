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
import { style } from "./ui.js";
import { providerDiagnostics, providerModelList, providerNames, providerPreset, withProviderModels } from "./providers.js";
import { syncConfiguredProviderModels, syncProviderModels } from "./model-sync.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";
import { contextPack, formatContextPack } from "./context.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];
const MAX_CONVERSATION_MESSAGES = 80;
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TUI_COMMANDS = [
  "help", "status", "health", "doctor", "dashboard", "sessions", "tools", "goals", "missions", "mission",
  "session", "policy", "tool", "memory", "agents", "agent", "providers", "provider", "login", "mode", "reasoning",
  "model", "models", "profile", "credentials", "keys", "workspace", "context", "progress", "review", "new", "compact", "clear", "exit", "quit"
];
const TOOL_POLICY_MODES = ["auto", "ask", "deny"];

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
  const onKeypress = (_, key) => handleKeypress(key, state, rl);
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

function handleKeypress(key, state, rl) {
  applyShortcut(key, state, { rl });
  if (key?.sequence !== "/") {
    if (rl.line !== "/") state.commandPaletteShown = false;
    return;
  }
  setTimeout(() => {
    if (rl.line !== "/" || state.commandPaletteShown) return;
    state.commandPaletteShown = true;
    output.write("\n");
    printCommandPalette(state);
    redrawPrompt(rl, state);
  }, 0);
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
      console.log(`Provider '${name}' is not configured. Run: azycode login ${name}`);
    } else {
      state.cfg.providers[name] = withProviderModels(state.cfg, name, state.cfg.providers[name]);
      state.cfg.activeProvider = name;
      state.cfg.activeModel = state.cfg.providers[name].model;
      saveConfig(state.cfg);
      console.log(`provider: ${name}/${state.cfg.activeModel}`);
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
    if (!PROFILES.includes(next)) console.log(`profile: ${PROFILES.join(", ")}`);
    else {
      state.cfg.permissionProfile = next;
      applyPermissionProfile(state.cfg);
      saveConfig(state.cfg);
      console.log(`profile: ${next}`);
      printPolicySummary(state);
    }
    return;
  }
  if (command === "context") {
    if (args[0] === "show") {
      console.log(formatContextPack(contextPack(state.cwd, { maxFiles: 20, maxBytes: 40000 })));
      return;
    }
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
  if (command === "health") {
    await printHealth(state);
    return;
  }
  if (command === "doctor") {
    printDoctor(state);
    return;
  }
  console.log(`Unknown command: /${command}. Use /help.`);
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
      console.log(`help: topics ${Object.keys(topics).join(", ")}`);
      return;
    }
    printRows(`Help: ${topic}`, rows);
    return;
  }
  console.log("");
  console.log(style("Commands", "cyan"));
  console.log("  /status                 show active model and git guard");
  console.log("  /health                 check configured provider connectivity");
  console.log("  /doctor                 show local binary and config paths");
  console.log("  /mode <name>            plan, always-approve, goal, review");
  console.log("  /reasoning <level>      minimal, low, medium, high");
  console.log("  /model [provider/model] show, sync, or switch provider/model");
  console.log("  /models [sync|sync all] list or sync provider model ids");
  console.log("  /providers              show available and configured providers");
  console.log("  /provider <name>        switch to a configured provider");
  console.log("  /credentials            show masked provider key sources");
  console.log("  /keys                   show keyboard shortcuts");
  console.log("  /profile <name>         normal, read-only, safe-write, full-auto");
  console.log("  /context                toggle bounded repository context");
  console.log("  /context show           preview bounded repository context");
  console.log("  /progress               toggle inline model/tool activity");
  console.log("  /review                 inspect local git changes");
  console.log("  /dashboard              show local session and automation counts");
  console.log("  /workspace              show cwd, config, git, and guard state");
  console.log("  /sessions               show recent agent sessions");
  console.log("  /session <id> [json]    show a saved session transcript");
  console.log("  /tools                  show recent tool activity");
  console.log("  /policy                 show current tool approval policy");
  console.log("  /tool <name> <mode>     set a tool to auto, ask, or deny");
  console.log("  /goals                  show saved goals");
  console.log("  /goal <action>          create, status, or stop a goal");
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

function printCommandPalette(state) {
  const rows = [
    ["/status", "active model, provider, guard"],
    ["/health", "provider connectivity"],
    ["/doctor", "local binary and config paths"],
    ["/login", "connect a provider"],
    ["/provider", "switch configured provider"],
    ["/model", "all models grouped by provider"],
    ["/providers", "show provider presets"],
    ["/credentials", "masked provider key sources"],
    ["/keys", "keyboard shortcuts"],
    ["/mode", "set plan, always-approve, goal, review"],
    ["/reasoning", "set minimal, low, medium, high"],
    ["/policy", "show tool approvals"],
    ["/tool", "set tool approval mode"],
    ["/agents", "show subagents"],
    ["/agent", "select subagent"],
    ["/missions", "show missions"],
    ["/memory", "manage notes"],
    ["/review", "local review"],
    ["/dashboard", "local overview"],
    ["/workspace", "cwd, config, git, guard"],
    ["/session", "show session transcript"],
    ["/clear", "redraw screen"],
    ["/exit", "leave azycode"]
  ];
  console.log("");
  console.log(style("Commands", "cyan"));
  const width = rows.reduce((max, [command]) => Math.max(max, command.length), 0);
  for (const [command, summary] of rows) {
    console.log(`  ${style(command.padEnd(width), "bold")}  ${summary}`);
  }
  console.log("");
  console.log(style(`active: ${state.cfg.activeProvider || "no provider"}/${state.cfg.activeModel || "no model"}  ${state.mode}  reasoning ${state.cfg.reasoning}`, "dim"));
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

function printWorkspace(state) {
  const guard = gitGuard(state.cwd, state.cfg);
  const git = gitSummary(state.cwd);
  console.log("");
  console.log(style("Workspace", "cyan"));
  printKeyValues([
    ["cwd", state.cwd],
    ["config", configPath()],
    ["home", azyHome()],
    ["branch", git.branch],
    ["dirty", git.dirty],
    ["guard", guard.ok ? "ok" : "blocked"],
    ["provider", state.cfg.activeProvider || "none"],
    ["model", state.cfg.activeModel || "none"],
    ["profile", state.cfg.permissionProfile || "normal"]
  ]);
  if (!guard.ok) console.log(style(`guard: ${guard.reason}`, "yellow"));
  console.log("");
}

function printReview(state) {
  const review = localReview(state.cwd);
  console.log(formatLocalReview(review));
  const actionable = review.findings.filter((item) => item.severity !== "info");
  if (!actionable.length) {
    console.log(style(`review: clean (${review.files.length} files, +${review.stats.added} -${review.stats.removed})`, "green"));
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

function printSession(args) {
  const [id, format] = args;
  const sessions = loadState().sessions || {};
  if (!id) {
    console.log("Usage: /session <id> [json]");
    return;
  }
  const session = sessions[id];
  if (!session) {
    console.log(`session: no session ${id}`);
    return;
  }
  console.log("");
  console.log(style(`Session ${id}`, "cyan"));
  if (format === "json") {
    console.log(JSON.stringify(session, null, 2));
  } else {
    console.log(formatSessionTranscript(session));
  }
  console.log("");
}

function formatSessionTranscript(session) {
  const lines = [];
  for (const message of session.messages || []) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      lines.push(`${style("assistant", "cyan")}: ${message.content || ""}`);
      for (const call of message.tool_calls || []) {
        lines.push(`${style("tool call", "dim")}: ${call.function?.name} ${call.function?.arguments || "{}"}`);
      }
    } else if (message.role === "tool") {
      lines.push(`${style(`tool ${message.name || ""}`.trim(), "dim")}: ${String(message.content || "").slice(0, 2000)}`);
    } else {
      lines.push(`${style(message.role || "message", "dim")}: ${message.content || ""}`);
    }
  }
  return lines.join("\n") || "(empty transcript)";
}

function printToolRuns() {
  const runs = (loadState().toolRuns || []).slice(-10).reverse();
  printRows("Tool runs", runs.map((run) => `${run.name}  ${run.ok ? "ok" : "failed"}  ${run.durationMs}ms  ${run.sessionId}`));
}

async function printHealth(state) {
  const names = Object.keys(state.cfg.providers || {});
  console.log("");
  console.log(style("Health", "cyan"));
  if (!names.length) {
    console.log("  No providers configured. Use /login.");
    console.log("");
    return;
  }
  for (const name of names) {
    try {
      const result = await new LlmClient(state.cfg, name).listModels();
      const count = Array.isArray(result) ? result.length : Object.keys(result || {}).length;
      const active = state.cfg.activeProvider === name ? "*" : " ";
      console.log(`  ${active} ${name.padEnd(12)} ok (${count} models)`);
    } catch (error) {
      console.log(`  ! ${name.padEnd(12)} failed (${error.message})`);
    }
  }
  console.log("");
}

function printDoctor(state) {
  console.log("");
  console.log(style("Doctor", "cyan"));
  printKeyValues([
    ["project", state.cwd],
    ["install root", INSTALL_ROOT],
    ["node", process.version],
    ["config home", azyHome()],
    ["active provider", state.cfg.activeProvider || "(none)"],
    ["active model", state.cfg.activeModel || "(none)"]
  ]);
  console.log("");
}

function printToolPolicy(state) {
  const policy = state.cfg.toolPolicy || {};
  const rows = Object.entries(policy)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, mode]) => `${name.padEnd(14)} ${mode}`);
  printRows("Tool policy", rows);
}

function printPolicySummary(state) {
  const values = Object.values(state.cfg.toolPolicy || {});
  const count = (mode) => values.filter((value) => value === mode).length;
  console.log(`policy: auto ${count("auto")}  ask ${count("ask")}  deny ${count("deny")}`);
}

function handleToolPolicy(args, state) {
  const [tool, mode] = args;
  const policy = state.cfg.toolPolicy || {};
  if (!tool || !mode) {
    console.log("Usage: /tool <name> <auto|ask|deny>");
    printRows("Known tools", Object.keys(policy).sort());
    return;
  }
  if (!Object.prototype.hasOwnProperty.call(policy, tool)) {
    console.log(`tool: unknown '${tool}'. Use /policy.`);
    return;
  }
  if (!TOOL_POLICY_MODES.includes(mode)) {
    console.log(`tool mode: ${TOOL_POLICY_MODES.join(", ")}`);
    return;
  }
  state.cfg.toolPolicy[tool] = mode;
  saveConfig(state.cfg);
  console.log(`tool: ${tool} -> ${mode}`);
}

function printModels(state) {
  const entries = modelSelectionEntries(state);
  if (!entries.length) {
    console.log("model: no providers available");
    return;
  }
  const rows = [];
  for (const name of orderedProviderNames(state.cfg)) {
    const providerEntries = entries.filter((entry) => entry.provider === name);
    if (!providerEntries.length) continue;
    const configured = Boolean(state.cfg.providers?.[name]);
    rows.push(`${configured ? "" : " "} ${name}${configured ? "" : " (not configured)"}`);
    for (const entry of providerEntries) {
      const active = state.cfg.activeProvider === entry.provider && state.cfg.activeModel === entry.model ? "*" : " ";
      rows.push(`  ${active} ${entry.model}`);
    }
  }
  printRows("Models", rows);
}

async function chooseModel(state, rl) {
  const entries = modelSelectionEntries(state).filter((entry) => entry.configured);
  if (!input.isTTY || !rl) {
    printModels(state);
    return;
  }
  if (!entries.length) {
    console.log("model: no configured providers. Use /login.");
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
    console.log(`model: ${selected.provider}/${selected.model}`);
    return;
  }
  if (modelMatches.length > 1) {
    console.log(`model: '${requested}' exists in multiple providers. Use provider/model.`);
    return;
  }
  if (!state.cfg.activeProvider || !state.cfg.providers[state.cfg.activeProvider]) {
    console.log("model: no configured provider. Use /login.");
    return;
  }
  state.cfg.activeModel = requested;
  state.cfg.providers[state.cfg.activeProvider] = withProviderModels(state.cfg, state.cfg.activeProvider, {
    ...state.cfg.providers[state.cfg.activeProvider],
    model: requested,
    models: [...providerModelList(state.cfg, state.cfg.activeProvider), requested]
  });
  saveConfig(state.cfg);
  console.log(`model: ${state.cfg.activeProvider}/${requested}`);
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
      console.log("models: no configured providers");
      return;
    }
    console.log(style("syncing all providers...", "dim"));
    const results = await syncConfiguredProviderModels(state.cfg, names);
    saveConfig(state.cfg);
    for (const result of results) {
      if (result.ok) {
        console.log(`models: ${result.provider} synced ${result.remoteCount} remote (${result.totalCount} total)`);
      } else {
        console.log(style(`models: ${result.provider} failed: ${result.error}`, "red"));
      }
    }
    return;
  }
  if (!state.cfg.activeProvider) {
    console.log("models: no active provider");
    return;
  }
  try {
    console.log(style("syncing models...", "dim"));
    const result = await syncProviderModels(state.cfg, state.cfg.activeProvider);
    saveConfig(state.cfg);
    console.log(`models: synced ${result.remoteCount} remote models`);
  } catch (error) {
    console.log(style(`models: ${error.message}`, "red"));
  }
}

function printGoals() {
  const goals = Object.entries(loadState().goals || {}).slice(-10).reverse();
  printRows("Goals", goals.map(([id, item]) => `${id}  ${item.status || ""}  ${item.text || ""}`));
}

function handleGoal(args) {
  const [action = "status", idOrText, ...rest] = args;
  const saved = loadState();
  if (action === "create") {
    const text = [idOrText, ...rest].filter(Boolean).join(" ").trim();
    if (!text) {
      console.log("Usage: /goal create <goal text>");
      return;
    }
    const id = `goal_${Date.now()}`;
    saved.goals[id] = { text, status: "created", createdAt: new Date().toISOString(), sessions: [] };
    saveState(saved);
    console.log(`goal: ${id} created`);
    return;
  }
  if (action === "status") {
    if (idOrText) {
      const goal = saved.goals?.[idOrText];
      if (!goal) console.log(`goal: no goal ${idOrText}`);
      else printRows(`Goal ${idOrText}`, [`status  ${goal.status || ""}`, `text    ${goal.text || ""}`, `started ${goal.startedAt || ""}`, `done    ${goal.finishedAt || ""}`]);
      return;
    }
    printGoals();
    return;
  }
  if (action === "stop") {
    const id = idOrText;
    if (!id) {
      console.log("Usage: /goal stop <id>");
      return;
    }
    if (!saved.goals?.[id]) {
      console.log(`goal: no goal ${id}`);
      return;
    }
    saved.goals[id].status = "stopped";
    saved.goals[id].finishedAt = new Date().toISOString();
    saveState(saved);
    console.log(`goal: ${id} stopped`);
    return;
  }
  console.log("Usage: /goal <create|status|stop>");
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
  if (action === "report" || action === "status") {
    const id = file;
    if (!id) {
      console.log(`Usage: /mission ${action} <id>`);
      return;
    }
    const mission = loadState().missions?.[id];
    if (!mission) {
      console.log(`mission: no mission ${id}`);
      return;
    }
    console.log(formatMissionReport(id, mission));
    return;
  }
  if (!["dry-run", "run"].includes(action) || !file) {
    console.log("Usage: /mission <dry-run|run|report|status> <file|id>");
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

function formatMissionReport(id, mission) {
  const lines = [
    "",
    style(`Mission ${id}`, "cyan"),
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
  printRows("Subagents", agents.map(([name, item]) => `${name}  ${item.reasoning || "medium"}  ${item.model || "(active model)"}  ${item.description || ""}`));
}

function printProviders(state) {
  const rows = providerNames().map((name) => {
    const preset = providerPreset(name);
    const configured = Boolean(state.cfg.providers?.[name]);
    const active = state.cfg.activeProvider === name ? "*" : " ";
    const model = state.cfg.providers?.[name]?.model || preset.defaultModel || "";
    const modelCount = configured ? providerModelList(state.cfg, name).length : (preset.models || []).length;
    return `${active} ${name.padEnd(12)} ${configured ? "configured" : "not configured"}  ${String(modelCount).padStart(2)} models  ${model}`;
  });
  printRows("Providers", rows);
  console.log(style("Use /model to choose provider and model together.", "dim"));
  console.log("");
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
    const active = state.cfg.activeProvider === name ? "*" : " ";
    const source = saved.apiKey ? `config:${maskSecret(saved.apiKey)}` : `env:${diag.apiKeySource}`;
    const keyStatus = diag.hasApiKey ? source : "missing";
    return `${active} ${name.padEnd(12)} ${keyStatus.padEnd(22)} ${diag.model}`;
  });
  printRows("Credentials", rows);
}

function printKeys() {
  printRows("Keyboard", [
    "Tab        rotate reasoning effort",
    "Shift+Tab  rotate mode",
    "Ctrl+C     cancel/exit",
    "Ctrl+D     submit multiline prompt in command mode"
  ]);
}

async function chooseConfiguredProvider(state, rl) {
  const names = Object.keys(state.cfg.providers || {});
  if (!names.length) {
    console.log("provider: none configured. Use /login.");
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
  console.log(`provider: ${selected}/${state.cfg.activeModel}`);
}

export async function loginProvider(state, rl) {
  if (!rl) {
    console.log("Interactive login requires a terminal. Run: azycode login <provider>");
    return;
  }
  const names = providerNames();
  console.log("");
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
  state.cfg.providers[name] = withProviderModels(state.cfg, name, { ...(state.cfg.providers[name] || {}), baseUrl, model, apiKey });
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

async function selectFromList({ title, items, active = null, rl, format = (item) => item }) {
  if (!items.length) return null;
  if (!input.isTTY || !rl) {
    console.log(style(title, "cyan"));
    for (const [index, item] of items.entries()) console.log(`  ${index + 1}. ${format(item)}`);
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
    const lines = [
      style(title, "cyan"),
      style("Use ↑/↓ or j/k, Enter to select, Esc to cancel", "dim"),
      ...items.map((item, itemIndex) => {
        const marker = itemIndex === index ? style("›", "cyan") : " ";
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
  console.log("");
  console.log(style(label, "cyan"));
  if (!rows.length) console.log("  (none)");
  else for (const row of rows) console.log(`  ${row}`);
  console.log("");
}
