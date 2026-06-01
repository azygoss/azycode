import fs from "node:fs";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { applyPermissionProfile, loadConfig, loadState, saveConfig, MODES, REASONING_LEVELS, normalizeMode, rotateMode, rotateReasoning } from "./config.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { formatGuard, gitGuard } from "./guard.js";
import { style } from "./ui.js";
import { providerNames, providerPreset } from "./providers.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];
const MAX_CONVERSATION_MESSAGES = 80;

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

  const rl = readlinePromises.createInterface({ input, output, completer: () => [[], ""] });
  emitKeypressEvents(input, rl);
  const onKeypress = (_, key) => applyShortcut(key, state, { rl });
  input.on("keypress", onKeypress);
  try {
    while (true) {
      const line = (await rl.question(promptLabel(state))).trim();
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
  console.log(style("azycode", "bold"));
  console.log(style(`${repo}  |  ${provider}/${model}  |  ${state.mode}  |  reasoning ${state.cfg.reasoning}`, "dim"));
  console.log(style("Type a task or /help. Tab: reasoning. Shift+Tab: mode. Ctrl+C: exit.", "dim"));
  console.log("");
}

function promptLabel(state) {
  const agent = state.subagent ? ` | @${state.subagent.name}` : "";
  return `${style(`[${state.mode} | ${state.cfg.reasoning}${agent}]`, "dim")} ${style(">", "cyan")} `;
}

export function applyShortcut(key, state, options = {}) {
  if (key?.name !== "tab") return;
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
  output.write(`\n${message}\n${promptLabel(state)}${rl.line || ""}`);
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
    console.log("Configure a provider in another terminal, then restart this workspace:");
    console.log("  azycode login <openai|kimi|zai-coding|minimax|opencode-go|byok>");
    return;
  }
  if (command === "status") {
    console.log(`${state.cfg.activeProvider || "no provider"}/${state.cfg.activeModel || "no model"}  |  ${state.mode}  |  reasoning ${state.cfg.reasoning}  |  profile ${state.cfg.permissionProfile || "normal"}  |  agent ${state.subagent?.name || "off"}  |  context ${state.includeContext}`);
    console.log(formatGuard(gitGuard(state.cwd, state.cfg)));
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
  console.log("  /login                  show provider setup command");
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
  console.log("");
  console.log(style("Dashboard", "cyan"));
  console.log(`  sessions    ${Object.keys(saved.sessions || {}).length}`);
  console.log(`  goals       ${Object.keys(saved.goals || {}).length}`);
  console.log(`  missions    ${Object.keys(saved.missions || {}).length}`);
  console.log(`  tool runs   ${(saved.toolRuns || []).length}`);
  console.log(`  messages    ${state.conversation.length}`);
  console.log(`  agent       ${state.subagent?.name || "off"}`);
  console.log("");
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

function printRows(label, rows) {
  console.log("");
  console.log(style(label, "cyan"));
  if (!rows.length) console.log("  (none)");
  else for (const row of rows) console.log(`  ${row}`);
  console.log("");
}
