import fs from "node:fs";
import path from "node:path";
import { emitKeypressEvents } from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { loadConfig, loadState, saveConfig, MODES, REASONING_LEVELS, normalizeMode, rotateMode, rotateReasoning } from "./config.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { formatGuard, gitGuard } from "./guard.js";
import { style } from "./ui.js";

const PROFILES = ["normal", "read-only", "safe-write", "full-auto"];

export async function launchTui({ cwd = process.cwd() } = {}) {
  const cfg = loadConfig();
  const state = {
    cfg,
    cwd,
    mode: normalizeMode(cfg.mode),
    includeContext: false,
    progress: true,
    conversation: []
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
    rl.setPrompt(promptLabel(state));
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line.startsWith("/")) {
        const done = await handleCommand(line, state);
        if (done === "exit") break;
      } else {
        await askAgent(line, state);
      }
      rl.setPrompt(promptLabel(state));
      rl.prompt();
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
  return `${style(`[${state.mode} | ${state.cfg.reasoning}]`, "dim")} ${style(">", "cyan")} `;
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

async function askAgent(prompt, state) {
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
      returnSession: true
    });
    state.conversation = result.messages.filter((message) => message.role !== "system");
    console.log("");
    console.log(style("assistant", "cyan"));
    console.log(result.content);
    console.log("");
  } catch (error) {
    console.log(style(`error: ${error.message}`, "red"));
    console.log("");
  }
}

function progressLine(event) {
  if (event.type === "model_start") console.log(style(`  model step ${event.step}`, "dim"));
  else if (event.type === "tool_start") console.log(style(`  tool  ${event.tool}`, "dim"));
  else if (event.type === "tool_end") console.log(style(`  done  ${event.tool} (${event.durationMs}ms)`, event.ok ? "green" : "red"));
}

async function handleCommand(line, state) {
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
  if (command === "profile") {
    const next = args[0];
    if (!PROFILES.includes(next)) console.log(`profile: ${PROFILES.join(", ")}`);
    else {
      state.cfg.permissionProfile = next;
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
  if (command === "login") {
    console.log("Configure a provider in another terminal, then restart this workspace:");
    console.log("  azycode login <openai|kimi|zai-coding|minimax|opencode-go|byok>");
    return;
  }
  if (command === "status") {
    console.log(`${state.cfg.activeProvider || "no provider"}/${state.cfg.activeModel || "no model"}  |  ${state.mode}  |  reasoning ${state.cfg.reasoning}  |  profile ${state.cfg.permissionProfile || "normal"}  |  context ${state.includeContext}`);
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
  console.log("  /profile <name>         normal, read-only, safe-write, full-auto");
  console.log("  /context                toggle bounded repository context");
  console.log("  /progress               toggle inline model/tool activity");
  console.log("  /review                 inspect local git changes");
  console.log("  /dashboard              show local session and automation counts");
  console.log("  /new                    start a fresh conversation");
  console.log("  /login                  show provider setup command");
  console.log("  /clear                  clear the terminal");
  console.log("  /exit                   leave azycode");
  console.log("");
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
  console.log("");
}
