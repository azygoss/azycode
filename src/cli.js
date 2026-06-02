import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { loadConfig, resolveAgentMaxSteps, saveConfig, loadState, saveState, maskSecret, MODES, REASONING_LEVELS, rotateMode, rotateReasoning, normalizeMode } from "./config.js";
import { AgentStepLimitError } from "./agent-errors.js";
import { LlmClient } from "./llm.js";
import { providerDiagnostics, providerModelList, providerNames, providerPreset, withProviderModels } from "./providers.js";
import { syncConfiguredProviderModels, syncProviderModels } from "./model-sync.js";
import { ask, askSecret } from "./prompt.js";
import { formatMissionPlan, loadMission, runMission } from "./missions.js";
import { addSubagent, listSubagents, removeSubagent } from "./subagents.js";
import { addSkill, listSkills, removeSkill, formatSkillsList } from "./skills.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { contextPack, formatContextPack, formatSnapshot, repoSnapshot } from "./context.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { formatGuard, gitGuard } from "./guard.js";
import { toolCatalog } from "./tools.js";
import * as ui from "./ui.js";
import { accent, badge, bold, box, brand, code, dim as dimText, error as errorText, faint, icon, info as infoText, keyValueList, muted, paint, pill, prettyMs, promptStatus, renderTable, rule, statusDot, style, subtle, success as successText, warn as warnText } from "./ui.js";
import { launchTui } from "./tui.js";
import { createAgentProgress, formatAgentEvent, formatAgentStepLine, runtimeSnapshot } from "./harness.js";

const VERSION = "0.1.0";
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = [
  "help", "providers", "init", "doctor", "login", "status", "model", "models", "provider", "health",
  "dashboard", "tools", "guard", "session", "memory", "context", "audit", "report", "completion", "config",
  "run", "chat", "always-approve", "approve", "plan", "review", "goal", "mission", "subagent", "skills", "keys"
];

async function runAgentSafe(options) {
  try {
    return await runAgent(options);
  } catch (error) {
    if (error instanceof AgentStepLimitError) {
      console.error(error.message);
    } else {
      console.error(`Agent error: ${error.message}`);
    }
    return undefined;
  }
}

export async function main(argv) {
  const [cmd, ...args] = argv;
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (!cmd) return launchTui({ cwd: process.cwd() });
  switch (cmd) {
    case "help": return help(args);
    case "providers": return providers();
    case "init": return init();
    case "doctor": return doctor(args);
    case "login": return login(args);
    case "status": return status();
    case "model": return modelCmd(args);
    case "models": return models(args);
    case "provider": return providerCmd(args);
    case "health": return health();
    case "dashboard": return dashboard();
    case "tools": return toolsCmd(args);
    case "guard": return guard(args);
    case "session": return session(args);
    case "memory": return memory(args);
    case "context": return contextCmd(args);
    case "audit": return audit();
    case "report": return report(args);
    case "completion": return completion(args);
    case "config": return configCmd(args);
    case "run": return run(args);
    case "chat": return chat(args);
    case "always-approve": return directMode("always-approve", args);
    case "approve": return directMode("always-approve", args);
    case "plan": return directMode("plan", args);
    case "review": return directMode("review", args);
    case "goal": return goal(args);
    case "mission": return mission(args);
    case "subagent": return subagent(args);
    case "skills": return skills(args);
    case "keys": return keys(args);
    default:
      if (cmd.startsWith("-")) return help();
      return run([cmd, ...args]);
  }
}

function help(args = []) {
  const topic = args[0];
  if (topic) return commandHelp(topic);
  console.log("");
  console.log(`${bold(`azycode ${VERSION}`)}  ${muted("·")}  ${muted("A lightweight AI coding harness for local repositories.")}`);
  console.log(rule(64, { char: "─", color: "rule" }));

  const groups = [
    { title: "Common workflows", items: [
      "azycode login <openai|kimi|zai-coding|minimax|opencode-go|byok>",
      "azycode dashboard",
      "azycode status",
      "azycode plan \"task\"",
      "azycode run --context --progress \"task\"",
      "azycode review --local",
      "azycode chat"
    ]},
    { title: "Project automation", items: [
      "azycode goal start \"goal\"",
      "azycode mission run ./mission.yml",
      "azycode subagent add <name>",
      "azycode skills add <name>",
      "azycode subagent run <name> \"task\"",
      "azycode skills list"
    ]},
    { title: "Inspect and configure", items: [
      "azycode providers",
      "azycode model | azycode model <provider/model> | azycode model sync [all]",
      "azycode models sync [all] | azycode models use <model>",
      "azycode tools | azycode tools log",
      "azycode guard status",
      "azycode context pack",
      "azycode config set mode <plan|always-approve|goal|review>",
      "azycode config set reasoning <minimal|low|medium|high>"
    ]},
    { title: "Diagnostics", items: [
      "azycode doctor [--json]",
      "azycode health",
      "azycode audit",
      "azycode report [file] [--with-audit]",
      "azycode completion <bash|zsh|fish>"
    ]},
    { title: "Interactive shortcuts", items: [
      "Shift+Tab rotates mode: plan -> always-approve -> goal -> review",
      "Tab rotates reasoning: minimal -> low -> medium -> high",
      "Ctrl+D submits the interactive prompt"
    ]}
  ];
  for (const group of groups) {
    console.log("");
    console.log(`${brand(icon("chevronRight"))} ${bold(group.title)}`);
    for (const item of group.items) console.log(`  ${muted(icon("arrow"))} ${item}`);
  }
  console.log("");
}

function commandHelp(topic) {
  const pages = {
    run: {
      summary: "Run the coding agent once against the current repository.",
      usage: [
        "azycode run \"task\"",
        "azycode run --context --progress \"task\""
      ],
      notes: ["Use --context to include a bounded source snapshot.", "Use --progress to stream model/tool progress to stderr."]
    },
    chat: {
      summary: "Start an interactive session with slash commands.",
      usage: ["azycode chat", "azycode chat --context --progress"],
      notes: ["/mode, /reasoning, /context, /progress, /review, /status, /exit"]
    },
    mission: {
      summary: "Run multi-step project automation from JSON or a small YAML subset.",
      usage: [
        "azycode mission run ./mission.yml",
        "azycode mission dry-run ./mission.yml",
        "azycode mission report <id>"
      ],
      notes: ["Mission steps can target subagents and declare dependencies."]
    },
    subagent: {
      summary: "Create and run focused agent profiles.",
      usage: [
        "azycode subagent list",
        "azycode subagent add <name>",
        "azycode subagent run <name> \"task\""
      ],
      notes: ["Built-ins: planner, reviewer, implementer."]
    },
    skills: {
      summary: "Manage reusable skill prompts.",
      usage: [
        "azycode skills list",
        "azycode skills add <name>",
        "azycode skills show <name>",
        "azycode skills remove <name>"
      ],
      notes: ["Apply skills with --skill <name> on run, plan, review, goal, chat."]
    },
    config: {
      summary: "Inspect and change local Azycode configuration.",
      usage: [
        "azycode config set mode <plan|always-approve|goal|review>",
        "azycode config set reasoning <minimal|low|medium|high>",
        "azycode config set profile <normal|read-only|safe-write|full-auto>",
        "azycode config export [file]"
      ],
      notes: ["Set AZYCODE_HOME to isolate credentials and state."]
    },
    login: {
      summary: "Store provider credentials without hardcoding keys.",
      usage: [
        "azycode login <openai|kimi|zai-coding|minimax|opencode-go|byok>",
        "azycode login byok --base-url http://127.0.0.1:11434/v1 --model local --api-key sk-local"
      ],
      notes: ["Keys are stored in ~/.azycode/config.json with 0600 permissions."]
    },
    model: {
      summary: "Show all known models under one provider-grouped view and switch provider/model together.",
      usage: [
        "azycode model",
        "azycode model <provider/model>",
        "azycode model sync all"
      ],
      notes: ["Configured providers are shown first. Selecting provider/model updates both active provider and active model."]
    },
    review: {
      summary: "Review local changes or ask the model for review.",
      usage: ["azycode review --local", "azycode review \"review current changes\""],
      notes: ["Local review is heuristic and does not call a provider."]
    }
  };
  const page = pages[topic];
  if (!page) {
    console.log(`No help topic '${topic}'. Try: ${Object.keys(pages).join(", ")}`);
    return;
  }
  ui.title(`azycode ${topic}`);
  console.log(page.summary);
  ui.section("Usage");
  ui.list(page.usage);
  if (page.notes?.length) {
    ui.section("Notes");
    ui.list(page.notes);
  }
}

function init() {
  fs.mkdirSync(".azycode/missions", { recursive: true });
  fs.mkdirSync(".azycode/agents", { recursive: true });
  const rules = ".azycode/rules.md";
  const mission = ".azycode/missions/example.yml";
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, "# Azycode Rules\n\n- Keep changes scoped.\n- Run relevant checks before final output.\n", "utf8");
  }
  if (!fs.existsSync(mission)) {
    fs.writeFileSync(mission, "name: repo-review\nmode: review\nsteps:\n  - \"Inspect the repository structure.\"\n  - \"Review current git diff and identify risks.\"\n", "utf8");
  }
  console.log("Initialized .azycode/ with rules, agents, and missions folders.");
}

function providers() {
  console.log("");
  console.log(`${bold("Providers")}`);
  console.log(rule(64, { char: "─", color: "rule" }));
  const rows = providerNames().map((name) => {
    const p = providerPreset(name);
    return {
      name,
      model: p.defaultModel,
      endpoint: p.baseUrl || "(custom)"
    };
  });
  for (const line of renderTable(rows, [
    { key: "name", label: "name" },
    { key: "model", label: "default model" },
    { key: "endpoint", label: "endpoint" }
  ])) console.log(`  ${line}`);
  const notes = providerNames()
    .map((name) => [name, providerPreset(name).note])
    .filter(([, note]) => note);
  if (notes.length) {
    console.log("");
    console.log(`${brand(icon("chevronRight"))} ${bold("Notes")}`);
    for (const [name, note] of notes) console.log(`  ${muted(name + ":")}  ${note}`);
  }
  console.log("");
  console.log(`${brand(icon("chevronRight"))} ${bold("Model selection")}`);
  console.log(`  ${muted(icon("arrow"))} Use ` + code("`azycode model`") + ` to see providers and models in one view.`);
  console.log(`  ${muted(icon("arrow"))} Use ` + code("`azycode model <provider/model>`") + ` to switch both together.`);
  console.log("");
}

function dashboard() {
  const cfg = loadConfig();
  const snap = runtimeSnapshot(cfg, process.cwd());

  console.log("");
  console.log(`${bold("Azycode Dashboard")}  ${muted("·")}  ${muted("local overview")}`);
  console.log(rule(64, { char: "─", color: "rule" }));
  const overview = [
    ["mode", snap.mode],
    ["reasoning", snap.reasoning],
    ["provider", snap.provider || "(none)"],
    ["model", snap.model || "(none)"],
    ["provider ready", badge(snap.providerReady ? "ok" : "missing")],
    ["always approve", badge(snap.alwaysApprove ? "on" : "off")],
    ["git guard", `${statusDot(snap.guard.ok ? "ok" : "blocked")} ${badge(snap.guard.ok ? "ok" : "blocked")}`]
  ];
  for (const row of keyValueList(overview)) console.log(`  ${row}`);
  if (!snap.guard.ok) console.log(`  ${muted("guard reason")}  ${warnText(snap.guard.reason)}`);
  if (!snap.providerReady) {
    console.log(`  ${warnText("Connect a provider:")} ${code("azycode login <provider>")}`);
  }

  console.log("");
  console.log(`${brand(icon("chevronRight"))} ${bold("State")}`);
  for (const line of renderTable([
    { item: "sessions", count: snap.counts.sessions },
    { item: "goals", count: snap.counts.goals },
    { item: "missions", count: snap.counts.missions },
    { item: "tool runs", count: snap.counts.toolRuns }
  ], [
    { key: "item", label: "item" },
    { key: "count", label: "count" }
  ])) console.log(`  ${line}`);

  console.log("");
  console.log(`${brand(icon("chevronRight"))} ${bold("Tool policy")}`);
  for (const line of renderTable([
    { policy: "auto", count: snap.policy.auto },
    { policy: "ask", count: snap.policy.ask },
    { policy: "deny", count: snap.policy.deny }
  ], [
    { key: "policy", label: "policy" },
    { key: "count", label: "count" }
  ])) console.log(`  ${line}`);
  console.log("");
}

function doctor(args = []) {
  const info = doctorInfo(process.cwd());
  if (args.includes("--json")) {
    console.log(JSON.stringify(info, null, 2));
    return;
  }
  ui.title("Doctor");
  ui.kv("project", info.project);
  ui.kv("install root", info.installRoot);
  ui.kv("package", `${info.packageName} ${info.version}`);
  ui.kv("node", info.node);
  ui.kv("npm", info.npm || "(unavailable)");
  ui.kv("platform", info.platform);
  ui.kv("local bin", info.localBin);
  ui.kv("local bin exists", ui.badge(info.localBinExists));
  ui.kv("PATH azycode", info.pathAzycode || "(none)");
  if (info.pathAzycode) ui.kv("PATH realpath", info.pathRealpath);
  if (info.pathAzycode && !info.pathMatchesLocal) {
    console.log("PATH note: global azycode differs from this workspace; use 'node ./bin/azycode.js' or 'npm link' in this project while developing.");
  }
}

function doctorInfo(root) {
  const localBin = path.resolve(INSTALL_ROOT, "bin", "azycode.js");
  const localReal = fs.existsSync(localBin) ? fs.realpathSync(localBin) : localBin;
  const packageJson = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, "package.json"), "utf8"));
  let which = "";
  let pathReal = "";
  let npmVersion = "";
  try {
    which = execFileSync("sh", ["-lc", "command -v azycode || true"], { encoding: "utf8" }).trim();
    pathReal = which ? fs.realpathSync(which) : "";
  } catch {
    which = "";
  }
  try {
    npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    npmVersion = "";
  }
  return {
    project: root,
    installRoot: INSTALL_ROOT,
    packageName: packageJson.name,
    version: packageJson.version,
    node: process.version,
    npm: npmVersion,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    localBin,
    localBinExists: fs.existsSync(localBin),
    localBinRealpath: localReal,
    pathAzycode: which,
    pathRealpath: pathReal,
    pathMatchesLocal: Boolean(which && pathReal === localReal)
  };
}

function completion(args = []) {
  const shell = args[0] || "zsh";
  const words = COMMANDS.join(" ");
  if (shell === "bash") {
    console.log(`_azycode_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
}
complete -F _azycode_complete azycode`);
    return;
  }
  if (shell === "fish") {
    console.log(`complete -c azycode -f -a "${words}"`);
    return;
  }
  if (shell === "zsh") {
    console.log(`#compdef azycode

_azycode() {
  local -a commands
  commands=(
    'help:show help'
    'providers:list provider presets'
    'init:create .azycode scaffold'
    'doctor:inspect installation'
    'login:add provider credentials'
    'status:show config and provider status'
    'models:list or select models'
    'provider:inspect active provider'
    'health:check configured providers'
    'dashboard:show local overview'
    'tools:list tool policy'
    'guard:show git guard'
    'session:inspect sessions'
    'memory:manage memory notes'
    'context:show repo context'
    'audit:run local product audit'
    'report:create redacted support report'
    'completion:emit shell completion'
    'config:manage configuration'
    'run:run coding agent'
    'chat:start interactive chat'
    'plan:plan mode'
    'review:review mode'
    'goal:manage goals'
    'mission:run missions'
    'subagent:manage subagents'
    'keys:show keyboard shortcuts'
  )
  _describe 'azycode command' commands
}

_azycode "$@"`);
    return;
  }
  throw new Error("Usage: azycode completion <bash|zsh|fish>");
}

function report(args = []) {
  const flags = parseFlags(args);
  const file = positionalArgs(args).find((item) => item !== "report");
  const state = loadState();
  const body = {
    generatedAt: new Date().toISOString(),
    doctor: doctorInfo(process.cwd()),
    config: redact(loadConfig()),
    guard: gitGuard(process.cwd(), loadConfig()),
    repository: repoSnapshot(process.cwd()),
    localReview: localReview(process.cwd()),
    counts: {
      sessions: Object.keys(state.sessions || {}).length,
      goals: Object.keys(state.goals || {}).length,
      missions: Object.keys(state.missions || {}).length,
      toolRuns: (state.toolRuns || []).length
    },
    recentToolRuns: (state.toolRuns || []).slice(-20)
  };
  if (flags.withAudit || flags["with-audit"]) body.audit = runAuditForReport();
  const output = `${JSON.stringify(body, null, 2)}\n`;
  if (file) {
    fs.writeFileSync(file, output, "utf8");
    console.log(`Report written to ${file}.`);
  } else {
    process.stdout.write(output);
  }
}

function runAuditForReport() {
  const result = {};
  for (const [name, [cmd, args]] of auditChecks()) {
    try {
      const output = execFileSync(cmd, args, { cwd: INSTALL_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      result[name] = { ok: true, output: output.slice(-4000) };
    } catch (error) {
      result[name] = {
        ok: false,
        status: error.status ?? null,
        output: `${error.stdout || ""}${error.stderr || ""}`.slice(-4000)
      };
    }
  }
  return result;
}

async function login(args) {
  const name = args[0];
  const preset = providerPreset(name);
  const cfg = loadConfig();
  const flags = parseFlags(args.slice(1));
  const baseUrl = flags.baseUrl || flags["base-url"] || await ask("Base URL", preset.baseUrl);
  const model = flags.model || await ask("Default model", preset.defaultModel);
  const apiKey = flags.apiKey || flags["api-key"] || await askSecret(`API key (${preset.envKey})`);
  cfg.providers[name] = withProviderModels(cfg, name, { ...(cfg.providers[name] || {}), baseUrl, model, apiKey });
  cfg.activeProvider = name;
  cfg.activeModel = model;
  saveConfig(cfg);
  console.log(`Logged in to ${name} with key ${maskSecret(apiKey)}.`);
}

function toolsCmd(args = []) {
  const cfg = loadConfig();
  if (args[0] === "log") {
    const state = loadState();
    ui.title("Tool Runs");
    ui.table((state.toolRuns || []).slice(-20).map((run) => ({
      at: run.at,
      session: run.sessionId,
      step: run.step,
      tool: run.name,
      ok: run.ok,
      ms: run.durationMs
    })), [
      { key: "at", label: "at" },
      { key: "session", label: "session" },
      { key: "step", label: "step" },
      { key: "tool", label: "tool" },
      { key: "ok", label: "ok" },
      { key: "ms", label: "ms" }
    ]);
    return;
  }
  const catalog = toolCatalog({ cwd: process.cwd(), cfg });
  if (args[0] === "inspect") {
    const selected = catalog.find((tool) => tool.name === args[1]);
    if (!selected) throw new Error("Usage: azycode tools inspect <tool>");
    ui.title(`Tool ${selected.name}`);
    ui.kv("policy", selected.policy);
    ui.kv("description", selected.description);
    ui.kv("parameters", selected.parameters.join(", ") || "(none)");
    ui.kv("required", selected.required.join(", ") || "(none)");
    return;
  }
  ui.title("Tool Catalog");
  ui.table(catalog.map((tool) => ({
    tool: tool.name,
    policy: tool.policy,
    params: tool.parameters.join(", "),
    description: tool.description
  })), [
    { key: "tool", label: "tool" },
    { key: "policy", label: "policy" },
    { key: "params", label: "params" },
    { key: "description", label: "description" }
  ]);
}

function guard(args) {
  const action = args[0] || "status";
  if (action !== "status") throw new Error("Usage: azycode guard status");
  console.log(formatGuard(gitGuard(process.cwd(), loadConfig())));
}

async function status() {
  const cfg = loadConfig();
  console.log("");
  console.log(`${bold("Status")}`);
  console.log(rule(64, { char: "─", color: "rule" }));
  const overview = [
    ["mode", cfg.mode],
    ["reasoning", cfg.reasoning],
    ["always approve", badge(cfg.alwaysApprove || cfg.mode === "always-approve")],
    ["active provider", cfg.activeProvider || "(none)"],
    ["active model", cfg.activeModel || "(none)"]
  ];
  for (const row of keyValueList(overview)) console.log(`  ${row}`);
  const providerRows = Object.entries(cfg.providers || {}).map(([name, p]) => {
    const preset = providerPreset(name);
    return {
      name,
      model: p.model,
      models: providerModelList(cfg, name).length,
      key: maskSecret(p.apiKey),
      quota: preset.quota || ""
    };
  });
  if (providerRows.length) {
    console.log("");
    console.log(`${brand(icon("chevronRight"))} ${bold("Configured providers")}`);
    for (const line of renderTable(providerRows, [
      { key: "name", label: "name" },
      { key: "model", label: "model" },
      { key: "models", label: "models" },
      { key: "key", label: "key" },
      { key: "quota", label: "quota" }
    ])) console.log(`  ${line}`);
  }
  console.log("");
  console.log(`${brand(icon("chevronRight"))} ${bold("Model selection")}`);
  console.log(`  ${muted(icon("arrow"))} Use ` + code("`azycode model`") + ` to view and select provider/model together.`);
  if (cfg.activeProvider) {
    console.log("");
    console.log(`${brand(icon("chevronRight"))} ${bold("Remote")}`);
    try {
      const client = new LlmClient(cfg);
      const models = await client.listModels();
      const count = Array.isArray(models) ? models.length : Object.keys(models || {}).length;
      const remote = [["status", `${statusDot("ok")} ${successText("ok")} ${faint(`(${count} models visible)`)}`]];
      const preset = providerPreset(cfg.activeProvider);
      remote.push(["limits", preset.quota || "provider-specific quota endpoints are not standardized."]);
      for (const row of keyValueList(remote)) console.log(`  ${row}`);
    } catch (error) {
      const remote = [["status", `${statusDot("error")} ${errorText("failed")} ${faint(error.message)}`]];
      for (const row of keyValueList(remote)) console.log(`  ${row}`);
    }
  }
  console.log("");
}

async function models(args = []) {
  if (args[0] === "sync") {
    const cfg = loadConfig();
    if (args[1] === "all") {
      const names = Object.keys(cfg.providers || {});
      if (!names.length) throw new Error("No configured providers. Run 'azycode login <provider>'.");
      const results = await syncConfiguredProviderModels(cfg, names);
      saveConfig(cfg);
      for (const result of results) {
        if (result.ok) {
          console.log(`${result.provider}: synced ${result.remoteCount} remote models (${result.totalCount} total).`);
        } else {
          console.log(`${result.provider}: failed: ${result.error}`);
        }
      }
      return;
    }
    if (!cfg.activeProvider) throw new Error("No active provider. Run 'azycode login <provider>'.");
    const result = await syncProviderModels(cfg, cfg.activeProvider);
    saveConfig(cfg);
    console.log(`Synced ${result.remoteCount} remote models for ${cfg.activeProvider}.`);
    return;
  }
  if (args[0] === "use") {
    const model = args[1];
    if (!model) throw new Error("Usage: azycode models use <model>");
    const cfg = loadConfig();
    const selected = selectCliModel(cfg, model);
    console.log(`Active model set to ${selected.provider}/${selected.model}.`);
    return;
  }
  if (args[0] === "inspect") {
    const cfg = loadConfig();
    if (!cfg.activeProvider) {
      console.log("No active provider. Run 'azycode login <provider>'.");
      return;
    }
    const model = args[1] || cfg.activeModel;
    const diag = providerDiagnostics({ ...cfg, activeModel: model }, cfg.activeProvider);
    console.log(JSON.stringify(diag, null, 2));
    return;
  }
  const cfg = loadConfig();
  const client = new LlmClient(cfg);
  const result = await client.listModels();
  if (Array.isArray(result)) {
    for (const model of result) console.log(model.id || model.name || JSON.stringify(model));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

function modelCmd(args = []) {
  if (args[0] === "sync") return models(args);
  const cfg = loadConfig();
  if (!args.length) {
    printCliModelHub(cfg);
    return;
  }
  const selected = selectCliModel(cfg, args.join(" "));
  console.log(`Active model set to ${selected.provider}/${selected.model}.`);
}

function printCliModelHub(cfg) {
  ui.title("Models");
  for (const provider of orderedProviderNames(cfg)) {
    const configured = Boolean(cfg.providers?.[provider]);
    const activeProvider = cfg.activeProvider === provider ? "*" : " ";
    console.log(`${activeProvider} ${provider}${configured ? "" : " (not configured)"}`);
    for (const model of providerModelList(cfg, provider)) {
      const activeModel = cfg.activeProvider === provider && cfg.activeModel === model ? "*" : " ";
      console.log(`  ${activeModel} ${model}`);
    }
  }
}

function orderedProviderNames(cfg) {
  const known = providerNames();
  const configured = Object.keys(cfg.providers || {}).filter((name) => known.includes(name));
  const active = cfg.activeProvider && known.includes(cfg.activeProvider) ? [cfg.activeProvider] : [];
  return [...new Set([...active, ...configured, ...known])];
}

function selectCliModel(cfg, requested) {
  const configured = Object.keys(cfg.providers || {});
  const entries = configured.flatMap((provider) => providerModelList(cfg, provider).map((model) => ({
    provider,
    model,
    id: `${provider}/${model}`
  })));
  const exact = entries.find((entry) => entry.id === requested);
  const matches = entries.filter((entry) => entry.model === requested);
  const selected = exact || (matches.length === 1 ? matches[0] : null);
  if (selected) {
    cfg.activeProvider = selected.provider;
    cfg.activeModel = selected.model;
    cfg.providers[selected.provider] = withProviderModels(cfg, selected.provider, {
      ...cfg.providers[selected.provider],
      model: selected.model,
      models: [...providerModelList(cfg, selected.provider), selected.model]
    });
    saveConfig(cfg);
    return selected;
  }
  if (matches.length > 1) throw new Error(`Model '${requested}' exists in multiple providers. Use provider/model.`);
  if (!cfg.activeProvider || !cfg.providers[cfg.activeProvider]) throw new Error("No configured provider. Run 'azycode login <provider>'.");
  cfg.activeModel = requested;
  cfg.providers[cfg.activeProvider] = withProviderModels(cfg, cfg.activeProvider, {
    ...cfg.providers[cfg.activeProvider],
    model: requested,
    models: [...providerModelList(cfg, cfg.activeProvider), requested]
  });
  saveConfig(cfg);
  return { provider: cfg.activeProvider, model: requested };
}

function providerCmd(args = []) {
  const action = args[0] || "current";
  if (action === "current") {
    const cfg = loadConfig();
    if (!cfg.activeProvider) {
      console.log("No active provider. Run 'azycode login <provider>'.");
      return;
    }
    console.log(JSON.stringify(providerDiagnostics(cfg), null, 2));
    return;
  }
  throw new Error("Usage: azycode provider current");
}

async function health() {
  const cfg = loadConfig();
  const names = Object.keys(cfg.providers || {});
  if (!names.length) {
    console.log("No providers configured. Run 'azycode login <provider>'.");
    return;
  }
  for (const name of names) {
    try {
      const client = new LlmClient(cfg, name);
      const result = await client.listModels();
      const count = Array.isArray(result) ? result.length : Object.keys(result || {}).length;
      console.log(`${name}: ok (${count} models)`);
    } catch (error) {
      console.log(`${name}: failed (${error.message})`);
    }
  }
}

async function configCmd(args) {
  const cfg = loadConfig();
  if (args[0] === "set" && args[1] === "mode") {
    const mode = normalizeMode(args[2]);
    if (!MODES.includes(mode)) throw new Error(`Mode must be one of: ${MODES.join(", ")}`);
    cfg.mode = mode;
  } else if (args[0] === "set" && args[1] === "reasoning") {
    if (!REASONING_LEVELS.includes(args[2])) throw new Error(`Reasoning must be one of: ${REASONING_LEVELS.join(", ")}`);
    cfg.reasoning = args[2];
  } else if (args[0] === "set" && args[1] === "model") {
    if (!args[2]) throw new Error("Usage: azycode config set model <model|provider/model>");
    selectCliModel(cfg, args[2]);
  } else if (args[0] === "set" && args[1] === "tool") {
    const [, , tool, mode] = args;
    if (!tool || !["auto", "ask", "deny"].includes(mode)) throw new Error("Usage: azycode config set tool <name> <auto|ask|deny>");
    cfg.toolPolicy ||= {};
    cfg.toolPolicy[tool] = mode;
  } else if (args[0] === "set" && args[1] === "profile") {
    const profile = args[2];
    if (!["normal", "read-only", "safe-write", "full-auto"].includes(profile)) {
      throw new Error("Profile must be one of: normal, read-only, safe-write, full-auto");
    }
    cfg.permissionProfile = profile;
  } else if (args[0] === "set" && args[1] === "guard") {
    const key = args[2];
    const value = parseBoolean(args[3]);
    cfg.gitGuard ||= {};
    if (key === "enabled") cfg.gitGuard.enabled = value;
    else if (key === "require-clean") cfg.gitGuard.requireClean = value;
    else throw new Error("Usage: azycode config set guard <enabled|require-clean> <true|false>");
  } else if (args[0] === "toggle" && args[1] === "always-approve") {
    cfg.alwaysApprove = !cfg.alwaysApprove;
  } else if (args[0] === "export") {
    const output = JSON.stringify(redact(cfg), null, 2);
    if (args[1]) fs.writeFileSync(args[1], `${output}\n`, "utf8");
    else console.log(output);
    return;
  } else if (args[0] === "import") {
    if (!args[1]) throw new Error("Usage: azycode config import <file>");
    const imported = JSON.parse(fs.readFileSync(args[1], "utf8"));
    if (JSON.stringify(imported).includes("...")) {
      throw new Error("Refusing to import redacted config. Use an unredacted config file.");
    }
    saveConfig({ ...cfg, ...imported });
    console.log("Config imported.");
    return;
  } else if (args[0] === "path") {
    console.log(process.env.AZYCODE_HOME || path.join(process.env.HOME, ".azycode"));
    return;
  } else {
    console.log(JSON.stringify(redact(cfg), null, 2));
    return;
  }
  saveConfig(cfg);
  console.log("Config updated.");
}

async function session(args) {
  const state = loadState();
  const action = args[0] || "list";
  if (action === "list") {
    if (args.includes("--json")) {
      console.log(JSON.stringify(state.sessions || {}, null, 2));
      return;
    }
    ui.title("Sessions");
    ui.table(Object.entries(state.sessions || {}).map(([id, item]) => ({
      id,
      created: item.createdAt || "",
      mode: item.mode || "",
      prompt: String(item.prompt || "").slice(0, 80)
    })), [
      { key: "id", label: "id" },
      { key: "created", label: "created" },
      { key: "mode", label: "mode" },
      { key: "prompt", label: "prompt" }
    ]);
    return;
  }
  if (action === "show") {
    const id = args[1];
    if (!state.sessions?.[id]) throw new Error(`No session ${id}`);
    console.log(JSON.stringify(state.sessions[id], null, 2));
    return;
  }
  if (action === "transcript") {
    const id = args[1];
    if (!state.sessions?.[id]) throw new Error(`No session ${id}`);
    console.log(formatTranscript(state.sessions[id]));
    return;
  }
  if (action === "export") {
    const [id, file] = args.slice(1);
    if (!id || !file) throw new Error("Usage: azycode session export <id> <file>");
    if (!state.sessions?.[id]) throw new Error(`No session ${id}`);
    fs.writeFileSync(file, `${JSON.stringify(state.sessions[id], null, 2)}\n`, "utf8");
    console.log(`Session ${id} exported to ${file}.`);
    return;
  }
  throw new Error("Usage: azycode session list|show <id>|transcript <id>|export <id> <file>");
}

async function memory(args) {
  const action = args[0] || "list";
  if (action === "add") {
    const text = args[1] || await ask("Memory note");
    const tags = args.slice(2);
    const note = addMemory(text, tags);
    console.log(`${note.id} added.`);
    return;
  }
  if (action === "list") {
    const notes = searchMemory(args.slice(1).join(" "));
    for (const note of notes) {
      const tagText = note.tags.length ? ` [${note.tags.join(",")}]` : "";
      console.log(`${note.id}${tagText} ${note.text}`);
    }
    return;
  }
  if (action === "remove") {
    const ok = removeMemory(args[1]);
    console.log(ok ? "Memory removed." : "Memory not found.");
    return;
  }
  throw new Error("Usage: azycode memory add|list|remove");
}

function contextCmd(args) {
  if (args[0] === "pack") {
    const flags = parseFlags(args.slice(1));
    console.log(formatContextPack(contextPack(process.cwd(), {
      maxFiles: flags.maxFiles || flags["max-files"],
      maxBytes: flags.maxBytes || flags["max-bytes"]
    })));
    return;
  }
  const snapshot = repoSnapshot(process.cwd());
  if (args[0] === "--json") console.log(JSON.stringify(snapshot, null, 2));
  else console.log(formatSnapshot(snapshot));
}

function audit() {
  let failed = 0;
  for (const [name, [cmd, args]] of auditChecks()) {
    console.log(`\n== ${name} ==`);
    try {
      const output = execFileSync(cmd, args, { cwd: INSTALL_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      process.stdout.write(output);
    } catch (error) {
      failed += 1;
      if (error.stdout) process.stdout.write(error.stdout);
      if (error.stderr) process.stderr.write(error.stderr);
      console.log(`${name} failed with exit ${error.status ?? "unknown"}`);
    }
  }
  if (failed) {
    process.exitCode = 1;
    console.log(`\naudit failed: ${failed} check(s) failed`);
  } else {
    console.log("\naudit passed");
  }
}

function auditChecks() {
  return [
    ["doctor", [process.execPath, ["./bin/azycode.js", "doctor"]]],
    ["syntax", ["npm", ["run", "check"]]],
    ["tests", ["npm", ["test"]]],
    ["pack", ["npm", ["run", "pack:dry"]]]
  ];
}

async function run(args) {
  const cfg = loadConfig();
  const flags = parseFlags(args);
  const prompt = positionalArgs(args).join(" ") || await interactivePrompt(cfg);
  const maxSteps = resolveAgentMaxSteps(cfg, flags["max-steps"]);
  const skills = parseSkills(args);
  const onEvent = flags.progress
    ? createAgentProgress({ maxSteps, style: "cli", onLine: (line) => console.error(line) })
    : null;
  const output = await runAgentSafe({ cfg, cwd: process.cwd(), prompt, maxSteps, onEvent, includeContext: Boolean(flags.context), skills });
  if (output === undefined) {
    process.exitCode = 1;
    return;
  }
  console.log(output);
}

async function chat(args) {
  const flags = parseFlags(args);
  const cfg = loadConfig();
  let mode = normalizeMode(flags.mode || cfg.mode);
  let includeContext = Boolean(flags.context);
  let progress = Boolean(flags.progress);
  console.log(`azycode chat mode=${mode} reasoning=${cfg.reasoning} context=${includeContext} progress=${progress}`);
  console.log("Slash commands: /mode <mode>, /reasoning <level>, /context, /progress, /review, /status, /skill, /exit");
  const skills = parseSkills(args);
  const chatState = { cfg, setMode: (next) => { mode = next; }, getMode: () => mode, setContext: (next) => { includeContext = next; }, getContext: () => includeContext, setProgress: (next) => { progress = next; }, getProgress: () => progress, skills, addSkill: (name) => { if (!cfg.skills?.[name]) { console.error(`No skill named ${name}`); return; } chatState.skills = [...chatState.skills, name]; }, removeSkill: (name) => { chatState.skills = chatState.skills.filter((s) => s !== name); }, getSkills: () => chatState.skills };
  if (!process.stdin.isTTY) {
    const lines = fs.readFileSync(0, "utf8").split(/\r?\n/);
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const done = await handleChatLine(line, chatState);
      if (done === "exit") break;
    }
    return;
  }
  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const line = (await rl.question("azycode> ")).trim();
      if (!line) continue;
      const done = await handleChatLine(line, chatState);
      if (done === "exit") break;
    }
  } finally {
    rl.close();
  }
}

async function directMode(mode, args) {
  const cfg = loadConfig();
  mode = normalizeMode(mode);
  const flags = parseFlags(args);
  if (mode === "review" && flags.local) {
    console.log(formatLocalReview(localReview(process.cwd())));
    return;
  }
  const prompt = positionalArgs(args, ["save"]).join(" ") || await interactivePrompt({ ...cfg, mode });
  const maxSteps = resolveAgentMaxSteps(cfg, flags["max-steps"]);
  const skills = parseSkills(args);
  const result = await runAgentSafe({
    cfg,
    cwd: process.cwd(),
    prompt,
    mode,
    maxSteps,
    returnSession: Boolean(flags.save),
    onEvent: flags.progress ? progressPrinter(maxSteps) : null,
    skills,
    includeContext: Boolean(flags.context)
  });
  if (result === undefined) {
    process.exitCode = 1;
    return;
  }
  if (flags.save) {
    fs.writeFileSync(flags.save, planArtifact({ mode, prompt, result }), "utf8");
    console.log(`Saved ${mode} artifact to ${flags.save}.`);
  }
  console.log(typeof result === "string" ? result : result.content);
}

async function goal(args) {
  const action = args[0] || "status";
  const state = loadState();
  if (action === "create") {
    const text = args.slice(1).join(" ");
    if (!text) throw new Error("Usage: azycode goal create \"goal text\"");
    const goalId = `goal_${Date.now()}`;
    state.goals[goalId] = { text, status: "created", createdAt: new Date().toISOString(), sessions: [] };
    saveState(state);
    console.log(goalId);
    return;
  }
  if (action === "start") {
    const cfg = loadConfig();
    const text = args.slice(1).join(" ");
    if (!text) throw new Error("Usage: azycode goal start \"goal text\"");
    const goalId = `goal_${Date.now()}`;
    state.goals[goalId] = { text, status: "running", startedAt: new Date().toISOString(), sessions: [] };
    saveState(state);
    const skills = parseSkills(args);
    const output = await runAgentSafe({ cfg, cwd: process.cwd(), prompt: text, mode: "goal", skills });
    const done = loadState();
    done.goals[goalId].status = output !== undefined ? "done" : "stalled";
    done.goals[goalId].finishedAt = new Date().toISOString();
    saveState(done);
    if (output !== undefined) console.log(output);
    return;
  }
  if (action === "resume") {
    const goalId = args[1];
    const selected = state.goals[goalId];
    if (!selected) throw new Error(`No goal ${goalId}`);
    const cfg = loadConfig();
    selected.status = "running";
    selected.resumedAt = new Date().toISOString();
    saveState(state);
    const prompt = `Continue this goal until it is complete. Goal: ${selected.text}`;
    const skills = parseSkills(args);
    const output = await runAgentSafe({ cfg, cwd: process.cwd(), prompt, mode: "goal", skills });
    const done = loadState();
    done.goals[goalId].status = output !== undefined ? "done" : "stalled";
    done.goals[goalId].finishedAt = new Date().toISOString();
    saveState(done);
    if (output !== undefined) console.log(output);
    return;
  }
  if (action === "status") {
    if (args.includes("--json")) {
      console.log(JSON.stringify(state.goals, null, 2));
      return;
    }
    ui.title("Goals");
    ui.table(Object.entries(state.goals || {}).map(([id, item]) => ({
      id,
      status: item.status || "",
      goal: item.text || ""
    })), [
      { key: "id", label: "id" },
      { key: "status", label: "status" },
      { key: "goal", label: "goal" }
    ]);
    return;
  }
  if (action === "stop") {
    const id = args[1];
    if (!state.goals[id]) throw new Error(`No goal ${id}`);
    state.goals[id].status = "stopped";
    state.goals[id].finishedAt = new Date().toISOString();
    saveState(state);
    console.log(`Goal ${id} stopped.`);
    return;
  }
  throw new Error("Usage: azycode goal create|start|resume|status|stop");
}

async function mission(args) {
  if ((args[0] || "list") === "list") {
    const state = loadState();
    if (args.includes("--json")) {
      console.log(JSON.stringify(state.missions || {}, null, 2));
      return;
    }
    ui.title("Missions");
    ui.table(Object.entries(state.missions || {}).map(([id, item]) => ({
      id,
      status: item.status || "",
      name: item.name || "",
      steps: (item.steps || []).length
    })), [
      { key: "id", label: "id" },
      { key: "status", label: "status" },
      { key: "name", label: "name" },
      { key: "steps", label: "steps" }
    ]);
    return;
  }
  if (args[0] === "status") {
    const state = loadState();
    const id = args.find((arg, index) => index > 0 && !arg.startsWith("--"));
    const selected = id ? state.missions?.[id] : state.missions;
    if (args.includes("--json") || !id) {
      console.log(JSON.stringify(selected || {}, null, 2));
      return;
    }
    if (!selected) throw new Error(`No mission ${id}`);
    console.log(formatMissionReport(id, selected));
    return;
  }
  if (args[0] === "dry-run" && args[1]) {
    console.log(formatMissionPlan(loadMission(args[1]), loadConfig()));
    return;
  }
  if (args[0] === "report" && args[1]) {
    const state = loadState();
    const selected = state.missions?.[args[1]];
    if (!selected) throw new Error(`No mission ${args[1]}`);
    console.log(formatMissionReport(args[1], selected));
    return;
  }
  if (args[0] !== "run" || !args[1]) throw new Error("Usage: azycode mission run ./mission.yml");
  const cfg = loadConfig();
  const result = await runMission({ cfg, cwd: process.cwd(), file: args[1] });
  console.log(`Mission ${result.missionId} completed.`);
  for (const step of result.outputs) {
    console.log(`\n# Step ${step.index}\n${step.output}`);
  }
}

async function subagent(args) {
  const action = args[0] || "list";
  if (action === "list") {
    ui.title("Subagents");
    ui.table(listSubagents(loadConfig()).map((agent) => ({
      name: agent.name,
      reasoning: agent.reasoning,
      model: agent.model || "(active)",
      description: agent.description || ""
    })), [
      { key: "name", label: "name" },
      { key: "reasoning", label: "reasoning" },
      { key: "model", label: "model" },
      { key: "description", label: "description" }
    ]);
    return;
  }
  if (action === "add") {
    const flags = parseFlags(args.slice(2));
    const name = args[1] || await ask("Name");
    const description = flags.description || await ask("Description", "");
    const system = flags.system || await ask("System prompt", "You are a focused coding subagent.");
    const model = flags.model || await ask("Model override", "");
    const reasoning = flags.reasoning || await ask("Reasoning", "medium");
    addSubagent({ name, description, system, model: model || null, reasoning });
    console.log(`Subagent ${name} added.`);
    return;
  }
  if (action === "remove") {
    removeSubagent(args[1]);
    console.log(`Subagent ${args[1]} removed.`);
    return;
  }
  if (action === "run") {
    const cfg = loadConfig();
    const name = args[1];
    const selected = cfg.subagents?.[name];
    if (!selected) throw new Error(`No subagent named ${name}.`);
    const prompt = args.slice(2).join(" ") || await interactivePrompt(cfg);
    const skills = parseSkills(args);
    const output = await runAgentSafe({ cfg, cwd: process.cwd(), prompt, subagent: selected, skills });
    if (output === undefined) {
      process.exitCode = 1;
      return;
    }
    console.log(output);
    return;
  }
  throw new Error("Usage: azycode subagent list|add|remove|run");
}

async function skills(args) {
  const action = args[0] || "list";
  if (action === "list") {
    ui.title("Skills");
    const items = listSkills(loadConfig());
    if (!items.length) {
      console.log(muted("No skills configured. Add one with: azycode skills add <name>"));
      return;
    }
    ui.table(items.map((skill) => ({
      name: skill.name,
      description: skill.description || ""
    })), [
      { key: "name", label: "name" },
      { key: "description", label: "description" }
    ]);
    return;
  }
  if (action === "add") {
    const flags = parseFlags(args.slice(2));
    const name = args[1] || await ask("Name");
    const description = flags.description || await ask("Description", "");
    const text = flags.text || await ask("Skill text", "");
    addSkill({ name, description, text });
    console.log(`Skill ${name} added.`);
    return;
  }
  if (action === "remove") {
    removeSkill(args[1]);
    console.log(`Skill ${args[1]} removed.`);
    return;
  }
  if (action === "show") {
    const cfg = loadConfig();
    const skill = cfg.skills?.[args[1]];
    if (!skill) throw new Error(`No skill named ${args[1]}.`);
    console.log(`${bold(skill.name || args[1])}${skill.description ? ` · ${muted(skill.description)}` : ""}`);
    console.log("");
    console.log(skill.text || muted("(empty)"));
    return;
  }
  throw new Error("Usage: azycode skills list|add|remove|show");
}

async function keys(args) {
  if (args[0] !== "shortcuts") return help();
  console.log("Shift+Tab: rotate mode. Tab: rotate reasoning. These are active in the multiline prompt reader.");
}

async function interactivePrompt(cfg) {
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  let text = "";
  process.stdout.write(`[mode=${cfg.mode} reasoning=${cfg.reasoning}] Enter task, Ctrl+D to run\n> `);
  return await new Promise((resolve) => {
    process.stdin.on("data", (chunk) => {
      if (chunk === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdout.write("\n");
        saveConfig(cfg);
        resolve(text.trim());
      } else if (chunk === "\u001b[Z") {
        cfg.mode = rotateMode(cfg.mode);
        process.stdout.write(`\n[mode=${cfg.mode}]\n> ${text}`);
      } else if (chunk === "\t") {
        cfg.reasoning = rotateReasoning(cfg.reasoning);
        process.stdout.write(`\n[reasoning=${cfg.reasoning}]\n> ${text}`);
      } else if (chunk === "\u0003") {
        process.stdin.setRawMode(false);
        process.exit(130);
      } else {
        text += chunk;
        process.stdout.write(chunk);
      }
    });
  });
}

function redact(cfg) {
  return {
    ...cfg,
    providers: Object.fromEntries(Object.entries(cfg.providers || {}).map(([name, p]) => [name, { ...p, apiKey: maskSecret(p.apiKey) }]))
  };
}

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return flags;
}

function parseSkills(args) {
  const skills = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--skill" && args[i + 1] && !args[i + 1].startsWith("--")) {
      skills.push(args[i + 1]);
      i += 1;
    }
  }
  return skills;
}

function parseBoolean(value) {
  if (value === "true" || value === "1" || value === "yes") return true;
  if (value === "false" || value === "0" || value === "no") return false;
  throw new Error("Boolean value must be true or false.");
}

function progressPrinter(maxSteps) {
  return createAgentProgress({
    maxSteps,
    style: "cli",
    onLine: (line) => console.error(line)
  });
}

function formatTranscript(session) {
  const lines = [];
  for (const msg of session.messages || []) {
    if (msg.role === "system") continue;
    if (msg.role === "assistant") {
      lines.push(`assistant: ${msg.content || ""}`);
      for (const call of msg.tool_calls || []) lines.push(`assistant tool_call: ${call.function?.name} ${call.function?.arguments || "{}"}`);
    } else if (msg.role === "tool") {
      lines.push(`tool ${msg.name}: ${String(msg.content || "").slice(0, 2000)}`);
    } else {
      lines.push(`${msg.role}: ${msg.content || ""}`);
    }
  }
  return lines.join("\n");
}

function formatMissionReport(id, mission) {
  const lines = [
    `mission: ${id}`,
    `name: ${mission.name}`,
    `status: ${mission.status}`,
    `startedAt: ${mission.startedAt || ""}`,
    `finishedAt: ${mission.finishedAt || ""}`,
    "steps:"
  ];
  for (const step of mission.steps || []) {
    lines.push(`- ${step.index}. ${step.status} ${step.prompt || ""}`);
    if (step.error) lines.push(`  error: ${step.error}`);
  }
  return lines.join("\n");
}

function positionalArgs(args, valueFlags = []) {
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      if (valueFlags.includes(arg.slice(2))) i += 1;
      continue;
    }
    positional.push(arg);
  }
  return positional;
}

function planArtifact({ mode, prompt, result }) {
  const content = typeof result === "string" ? result : result.content;
  const sessionId = typeof result === "string" ? null : result.sessionId;
  return [
    `# Azycode ${mode} Artifact`,
    "",
    `createdAt: ${new Date().toISOString()}`,
    sessionId ? `sessionId: ${sessionId}` : null,
    "",
    "## Prompt",
    "",
    prompt,
    "",
    "## Output",
    "",
    content,
    ""
  ].filter((line) => line !== null).join("\n");
}

async function handleChatCommand(line, state) {
  const [command, ...rest] = line.slice(1).split(/\s+/);
  if (command === "exit" || command === "quit") return "exit";
  if (command === "mode") {
    const next = normalizeMode(rest[0]);
    if (!MODES.includes(next)) console.log(`Mode must be one of: ${MODES.join(", ")}`);
    else {
      state.setMode(next);
      console.log(`mode=${next}`);
    }
    return;
  }
  if (command === "reasoning") {
    const next = rest[0];
    if (!REASONING_LEVELS.includes(next)) console.log(`Reasoning must be one of: ${REASONING_LEVELS.join(", ")}`);
    else {
      state.cfg.reasoning = next;
      saveConfig(state.cfg);
      console.log(`reasoning=${next}`);
    }
    return;
  }
  if (command === "context") {
    state.setContext(!state.getContext());
    console.log(`context=${state.getContext()}`);
    return;
  }
  if (command === "progress") {
    state.setProgress(!state.getProgress());
    console.log(`progress=${state.getProgress()}`);
    return;
  }
  if (command === "review") {
    console.log(formatLocalReview(localReview(process.cwd())));
    return;
  }
  if (command === "status") {
    console.log(`mode=${state.getMode()} reasoning=${state.cfg.reasoning} context=${state.getContext()} progress=${state.getProgress()}`);
    console.log(formatGuard(gitGuard(process.cwd(), state.cfg)));
    return;
  }
  if (command === "skill") {
    const action = rest[0];
    const name = rest[1];
    if (action === "add" && name) {
      state.addSkill(name);
      console.log(`skill +${name} · active: ${state.getSkills().join(", ") || "(none)"}`);
    } else if (action === "remove" && name) {
      state.removeSkill(name);
      console.log(`skill -${name} · active: ${state.getSkills().join(", ") || "(none)"}`);
    } else if (action === "list") {
      const items = listSkills(state.cfg);
      const active = new Set(state.getSkills());
      if (!items.length) console.log("No skills configured.");
      else items.forEach((s) => console.log(`${active.has(s.name) ? "●" : "○"} ${s.name}${s.description ? ` · ${s.description}` : ""}`));
    } else {
      console.log("Usage: /skill add <name> | /skill remove <name> | /skill list");
    }
    return;
  }
  if (command === "help") {
    console.log("Slash commands: /mode <mode>, /reasoning <level>, /context, /progress, /review, /status, /skill, /exit");
    return;
  }
  console.log(`Unknown slash command: /${command}`);
}

async function handleChatLine(line, state) {
  if (line.startsWith("/")) return handleChatCommand(line, state);
  const maxSteps = resolveAgentMaxSteps(state.cfg);
  const result = await runAgentSafe({
    cfg: state.cfg,
    cwd: process.cwd(),
    prompt: line,
    mode: state.getMode(),
    maxSteps,
    includeContext: state.getContext(),
    onEvent: state.getProgress() ? progressPrinter(maxSteps) : null,
    skills: state.getSkills()
  });
  if (result !== undefined) console.log(result);
}
