import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runAgent } from "./agent.js";
import { applyPermissionProfile, COMPACTION_MODES, defaultConfig, loadConfig, resolveAgentMaxSteps, saveConfig, loadState, saveState, updateState, maskSecret, MODES, REASONING_LEVELS, rotateMode, rotateReasoning, normalizeMode } from "./config.js";
import { loadCustomCommands, previewCustomCommand, resolveCustomCommand } from "./commands.js";
import { compactConversationDeterministic, compactConversationWithModel } from "./compaction.js";
import { clearAllTodos, clearCompletedTodos, formatActiveTodos, formatTodoList, listActiveTodos, listTodos } from "./todos.js";
import { loadHookConfig } from "./hooks.js";
import { trimConversation } from "./conversation.js";
import { AgentCancelledError, AgentRunError, AgentStepLimitError } from "./agent-errors.js";
import { LlmClient } from "./llm.js";
import { providerDiagnostics, providerModelList, providerNames, providerPreset, withProviderModels } from "./providers.js";
import { syncConfiguredProviderModels, syncProviderModels } from "./model-sync.js";
import { ask, askSecret } from "./prompt.js";
import { buildMissionDryRun, formatMissionPlan, loadMission, runMission } from "./missions.js";
import { addSubagent, formatSubagentResults, listSubagents, removeSubagent, runSubagentsParallel } from "./subagents.js";
import {
  addSkill,
  exportSkill,
  formatSkillsList,
  getSkillRecord,
  importSkill,
  listAllSkills,
  listSkills,
  removeSkill,
  writeProjectSkill
} from "./skills.js";
import { inspectMcpServer, listConfiguredMcpServers, probeMcpServers } from "./mcp.js";
import { addMemory, removeMemory, searchMemory } from "./memory.js";
import { contextPack, formatContextPack, formatSnapshot, repoSnapshot } from "./context.js";
import { formatLocalReview, localReview } from "./local-review.js";
import { formatPatchValidationReport, validatePatch } from "./patch-validation.js";
import {
  buildSecurityReview,
  formatSecurityReview,
  formatSecurityReviewCombined,
  formatSecurityReviewJson,
  securityReviewPrompt
} from "./security-review.js";
import { formatGuard, formatGuardJson, gitGuard } from "./guard.js";
import { runAllBenchmarks, formatBenchReport, listBenchmarks } from "./bench.js";
import { describePermissionProfile, PERMISSION_PROFILES } from "./permissions.js";
import { describeExecutionPolicy, resolveExecutionPolicy, sandboxStatus, SANDBOX_MODES, SANDBOX_NETWORK_MODES, SANDBOX_FALLBACK_MODES } from "./execution-policy.js";
import { formatLocalReviewJson } from "./local-review.js";
import { toolCatalog } from "./tools.js";
import * as ui from "./ui.js";
import { accent, badge, bold, box, brand, code, dim as dimText, error as errorText, faint, icon, info as infoText, keyValueList, muted, paint, pill, prettyMs, promptStatus, renderTable, rule, statusDot, style, subtle, success as successText, warn as warnText } from "./ui.js";
import { launchTui } from "./tui.js";
import { createAgentProgress, formatAgentRunSummary, formatAgentStepLine, formatSessionTranscript, formatToolRunLine, hasActiveProvider, runtimeSnapshot, sessionListEntries, summarizeAgentRun, summarizeToolArgs, toolRunListEntries, withAgentAbort } from "./harness.js";
import { discoverProjectInstructions, listInstructionSources } from "./instructions.js";
import { expandFileReferences } from "./prompt-expand.js";
import { readMultilinePrompt } from "./composer-input.js";

const VERSION = "0.1.0";
const INSTALL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COMMANDS = [
  "help", "providers", "init", "doctor", "login", "status", "model", "models", "provider", "health",
  "dashboard", "tools", "guard", "session", "memory", "context", "todo", "audit", "report", "completion", "config",
  "run", "exec", "chat", "always-approve", "approve", "build", "plan", "review", "goal", "mission", "subagent", "skills", "keys", "mcp", "instructions", "hooks", "commands", "bench", "sandbox", "patch"
];

async function runAgentSafe(options, { cancellable = false } = {}) {
  const invoke = (signal) => runAgent({ progressStyle: "cli", signal, ...options });
  try {
    if (cancellable && process.stdin.isTTY) {
      return await withAgentAbort(invoke, {
        onCancel: () => console.error("Cancelling agent run… (Ctrl+C again to exit)")
      });
    }
    return await invoke(options.signal || null);
  } catch (error) {
    if (error instanceof AgentCancelledError) {
      console.error("Agent run cancelled.");
    } else if (error instanceof AgentStepLimitError) {
      console.error(error.message);
    } else if (error instanceof AgentRunError && error.report) {
      console.error(error.message);
    } else if (error.message?.includes("No active provider")) {
      console.error("No active provider configured. Run 'azycode login <provider>' first.");
    } else if (error.message?.includes("API key") || error.message?.includes("apiKey")) {
      console.error(`API key issue: ${error.message}. Check your provider credentials with 'azycode doctor'.`);
    } else if (error.message?.includes("TimeoutError") || error.message?.includes("timeout")) {
      console.error(`Request timed out: ${error.message}. Increase AZYCODE_REQUEST_TIMEOUT_MS or check provider status.`);
    } else if (error.message?.includes("fetch failed") || error.message?.includes("ECONNREFUSED")) {
      console.error(`Network error: ${error.message}. Check your internet connection and provider endpoint.`);
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
    case "status": return status(args);
    case "model": return modelCmd(args);
    case "models": return models(args);
    case "provider": return providerCmd(args);
    case "health": return health(args);
    case "dashboard": return dashboard();
    case "tools": return toolsCmd(args);
    case "guard": return guard(args);
    case "session": return session(args);
    case "memory": return memory(args);
    case "context": return await contextCmd(args);
    case "todo": return todoCmd(args);
    case "audit": return audit();
    case "report": return report(args);
    case "completion": return completion(args);
    case "config": return configCmd(args);
    case "run": return run(args);
    case "exec": return execCmd(args);
    case "chat": return chat(args);
    case "mcp": return mcpCmd(args);
    case "instructions": return instructionsCmd(args);
    case "hooks": return hooksCmd(args);
    case "commands": return commandsCmd(args);
    case "bench": return await benchCmd(args);
    case "sandbox": return sandboxCmd(args);
    case "patch": return await patchCmd(args);
    case "always-approve": return directMode("always-approve", args);
    case "approve": return directMode("always-approve", args);
    case "build": return directMode("build", args);
    case "normal": return directMode("build", args);
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
      "azycode bench run --mock",
      "azycode context pack",
      "azycode config set mode <plan|build|always-approve|goal|review>",
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
      "Shift+Tab rotates mode: plan -> build -> always-approve -> goal -> review",
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
      notes: ["Built-ins: planner, reviewer, implementer, explorer.", "Use spawn for parallel subagent runs."]
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
        "azycode config set mode <plan|build|always-approve|goal|review>",
        "azycode config set reasoning <minimal|low|medium|high>",
        "azycode config set profile <normal|read-only|plan-only|safe-write|trusted-workspace|full-auto>",
        "azycode config set guard enabled <true|false>",
        "azycode config set compaction <trim|deterministic|llm>",
        "azycode config set api-mode <chat|responses>",
        "azycode status --json",
        "azycode health --json",
        "azycode todo list|active|clear [--json]",
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
      usage: [
        "azycode review --local",
        "azycode review --local --json",
        "azycode review --security",
        "azycode review --security --json",
        "azycode review \"review current changes\""
      ],
      notes: ["Local review is heuristic and does not call a provider.", "--security combines local heuristics with optional model review."]
    },
    patch: {
      summary: "Validate patches in an isolated worktree before applying them.",
      usage: ["azycode patch validate patch.diff", "azycode patch validate patch.diff --json", "azycode patch validate patch.diff --check \"npm test\""],
      notes: ["Never mutates the main workspace.", "Falls back to git apply --check when worktrees are unavailable."]
    },
    permissions: {
      summary: "Permission profiles control tool categories: read, write, shell, network, git, MCP, subagents.",
      usage: [
        "azycode config set profile read-only",
        "azycode config set profile plan-only",
        "azycode config set profile trusted-workspace",
        "azycode config set profile full-auto"
      ],
      notes: PERMISSION_PROFILES.map((p) => `${p}: ${describePermissionProfile(p).description}`)
    },
    sandbox: {
      summary: "Execution policy and optional container sandbox backends.",
      usage: [
        "azycode config set sandbox.mode local|docker|podman|none",
        "azycode help sandbox"
      ],
      notes: [
        "sandbox.mode=local runs on host with env allowlist and command redaction.",
        "docker/podman backends mount workspace and optionally disable network.",
        "Path guard and git guard apply regardless of sandbox mode."
      ]
    },
    bench: {
      summary: "Internal benchmark harness for deterministic regression checks.",
      usage: [
        "azycode bench list",
        "azycode bench run --mock",
        "azycode bench run --mock --json"
      ],
      notes: ["Uses mock evaluation by default; no provider required."]
    },
    guard: {
      summary: "Git guard blocks writes and shell on protected branches (main/master) by default.",
      usage: [
        "azycode guard status",
        "azycode guard status --json",
        "azycode config set guard enabled false"
      ],
      notes: ["Use git_checkout with create:true to switch to a feature branch."]
    },
    context: {
      summary: "Repository context packs with layered retrieval and injection hardening.",
      usage: ["azycode context pack", "azycode context snapshot"],
      notes: ["Context files are wrapped as untrusted data except AGENTS.md and .azycode/rules.md."]
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
  fs.mkdirSync(".azycode/commands", { recursive: true });
  const rules = ".azycode/rules.md";
  const agents = "AGENTS.md";
  const mission = ".azycode/missions/example.yml";
  const hooks = ".azycode/hooks.json";
  const reviewCmd = ".azycode/commands/review.md";
  if (!fs.existsSync(agents)) {
    fs.writeFileSync(agents, "# AGENTS.md\n\n## Repository expectations\n\n- Keep changes scoped and verifiable.\n- Run relevant checks before final output.\n- Match existing code style and naming.\n", "utf8");
  }
  if (!fs.existsSync(rules)) {
    fs.writeFileSync(rules, "# Azycode Rules\n\n- Keep changes scoped.\n- Run relevant checks before final output.\n", "utf8");
  }
  if (!fs.existsSync(mission)) {
    fs.writeFileSync(mission, "name: repo-review\nmode: review\nsteps:\n  - \"Inspect the repository structure.\"\n  - \"Review current git diff and identify risks.\"\n", "utf8");
  }
  if (!fs.existsSync(hooks)) {
    fs.writeFileSync(hooks, `${JSON.stringify({
      agent_run_start: [],
      agent_run_end: [],
      pre_model: [],
      post_model: [],
      pre_tool: [],
      post_tool: []
    }, null, 2)}\n`, "utf8");
  }
  if (!fs.existsSync(reviewCmd)) {
    fs.writeFileSync(reviewCmd, `---
name: review
description: Focused local code review
---
Review the current git diff and recent changes.
Lead with actionable findings ordered by severity.
Cite file paths and include verification gaps.
`, "utf8");
  }
  const parallelMission = ".azycode/missions/parallel-review.json";
  if (!fs.existsSync(parallelMission)) {
    fs.writeFileSync(parallelMission, `${JSON.stringify({
      name: "parallel-review",
      mode: "review",
      passContext: true,
      steps: [
        { id: "plan", prompt: "Outline a concise review plan for the current repository changes." },
        {
          id: "parallel-review",
          dependsOn: "plan",
          parallel: [
            { id: "diff-review", agent: "reviewer", prompt: "Review the current git diff for bugs and regressions." },
            { id: "structure-scan", agent: "explorer", prompt: "Map the repository areas most likely affected by the diff." }
          ]
        },
        { id: "summarize", dependsOn: "parallel-review", prompt: "Combine the parallel review outputs into one prioritized action list." }
      ]
    }, null, 2)}\n`, "utf8");
  }
  console.log("Initialized AGENTS.md, .azycode/ rules, agents, missions, hooks, and commands.");
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
    ["profile", snap.profile],
    ["provider", snap.provider || "(none)"],
    ["model", snap.model || "(none)"],
    ["provider ready", badge(snap.providerReady ? "ok" : "missing")],
    ["always approve", badge(snap.alwaysApprove ? "on" : "off")],
    ["compaction", cfg.compaction || "trim"],
    ["stream", badge(cfg.streamResponses ? "on" : "off")],
    ["agent steps", snap.agentMaxSteps ? String(snap.agentMaxSteps) : "unlimited"],
    ["skills", String(snap.counts.skills)],
    ["subagents", String(snap.counts.subagents)],
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
    const zshCommands = COMMANDS.map((name) => `    '${name}:${name} command'`).join("\n");
    console.log(`#compdef azycode

_azycode() {
  local -a commands
  commands=(
${zshCommands}
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
    ui.table(toolRunListEntries(state.toolRuns || {}), [
      { key: "at", label: "at" },
      { key: "session", label: "session" },
      { key: "step", label: "step" },
      { key: "tool", label: "tool" },
      { key: "summary", label: "summary" },
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
  const json = args.includes("--json");
  if (action !== "status") throw new Error("Usage: azycode guard status [--json]");
  const result = gitGuard(process.cwd(), loadConfig());
  if (json) {
    console.log(JSON.stringify(formatGuardJson(result), null, 2));
    return;
  }
  console.log(formatGuard(result));
}

function sandboxCmd(args) {
  const action = args[0] || "status";
  const json = args.includes("--json");
  if (action !== "status") throw new Error("Usage: azycode sandbox status [--json]");
  const cfg = loadConfig();
  const status = sandboxStatus(cfg, process.cwd());
  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  console.log("Sandbox status");
  console.log(`mode: ${status.policy.mode}`);
  console.log(`network: ${status.policy.network}`);
  console.log(`fallback: ${status.policy.fallbackMode}`);
  console.log(`image: ${status.policy.image}`);
  console.log(`effective backend: ${status.effectiveBackend}`);
  console.log(`local shell: ${status.localShell.shellName} (${status.localShell.file})`);
  console.log(`docker: ${status.runtimes.docker.available ? "available" : "missing"}${status.runtimes.docker.selected ? " (selected)" : ""}`);
  console.log(`podman: ${status.runtimes.podman.available ? "available" : "missing"}${status.runtimes.podman.selected ? " (selected)" : ""}`);
}

async function benchCmd(args) {
  const action = args[0] || "run";
  const json = args.includes("--json");
  const mock = args.includes("--mock") || !args.includes("--live");
  if (action === "list") {
    const items = listBenchmarks();
    if (json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    for (const item of items) console.log(`${item.id}\t${item.name || item.id}\t${item.type || ""}`);
    return;
  }
  if (action === "run") {
    const report = await runAllBenchmarks({ mock });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(formatBenchReport(report));
    if (report.failed > 0) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: azycode bench <list|run> [--mock] [--json]");
}

async function status(args = []) {
  const flags = parseFlags(args);
  const cfg = loadConfig();
  let remote = null;
  if (cfg.activeProvider) {
    try {
      const client = new LlmClient(cfg);
      const models = await client.listModels();
      const count = Array.isArray(models) ? models.length : Object.keys(models || {}).length;
      remote = { ok: true, modelCount: count };
    } catch (error) {
      remote = { ok: false, error: error.message };
    }
  }
  const diagnostics = cfg.activeProvider
    ? providerDiagnostics(cfg, cfg.activeProvider, cfg.activeModel)
    : null;
  if (flags.json) {
    console.log(JSON.stringify({
      mode: cfg.mode,
      reasoning: cfg.reasoning,
      alwaysApprove: Boolean(cfg.alwaysApprove || cfg.mode === "always-approve"),
      compaction: cfg.compaction || "trim",
      activeProvider: cfg.activeProvider || null,
      activeModel: cfg.activeModel || null,
      providers: Object.keys(cfg.providers || {}),
      remote,
      diagnostics
    }, null, 2));
    return;
  }
  console.log("");
  console.log(`${bold("Status")}`);
  console.log(rule(64, { char: "─", color: "rule" }));
  const overview = [
    ["mode", cfg.mode],
    ["reasoning", cfg.reasoning],
    ["always approve", badge(cfg.alwaysApprove || cfg.mode === "always-approve")],
    ["compaction", cfg.compaction || "trim"],
    ["active provider", cfg.activeProvider || "(none)"],
    ["active model", cfg.activeModel || "(none)"]
  ];
  for (const row of keyValueList(overview)) console.log(`  ${row}`);
  if (diagnostics) {
    console.log("");
    console.log(`${brand(icon("chevronRight"))} ${bold("Active model capabilities")}`);
    const capRows = [
      ["api mode", diagnostics.apiMode],
      ["protocol", diagnostics.protocol],
      ["path", diagnostics.activePath],
      ["tools", diagnostics.supportsTools ? badge("ok") : badge("off")],
      ["streaming", diagnostics.supportsStreaming ? badge("ok") : badge("off")],
      ["reasoning", diagnostics.supportsReasoningEffort ? badge("ok") : badge("off")]
    ];
    for (const row of keyValueList(capRows)) console.log(`  ${row}`);
    if (diagnostics.lastFailure) {
      console.log(`  ${warnText("last failure")}: ${faint(diagnostics.lastFailure.message)}`);
    }
  }
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
    if (remote?.ok) {
      const remoteRows = [["status", `${statusDot("ok")} ${successText("ok")} ${faint(`(${remote.modelCount} models visible)`)}`]];
      const preset = providerPreset(cfg.activeProvider);
      remoteRows.push(["limits", preset.quota || "provider-specific quota endpoints are not standardized."]);
      for (const row of keyValueList(remoteRows)) console.log(`  ${row}`);
    } else if (remote) {
      const remoteRows = [["status", `${statusDot("error")} ${errorText("failed")} ${faint(remote.error)}`]];
      for (const row of keyValueList(remoteRows)) console.log(`  ${row}`);
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

async function health(args = []) {
  const flags = parseFlags(args);
  const cfg = loadConfig();
  const names = Object.keys(cfg.providers || {});
  if (!names.length) {
    if (flags.json) console.log(JSON.stringify({ providers: [], ok: false, error: "No providers configured." }, null, 2));
    else console.log("No providers configured. Run 'azycode login <provider>'.");
    return;
  }
  const results = await Promise.all(names.map(async (name) => {
    const diagnostics = providerDiagnostics(cfg, name);
    try {
      const client = new LlmClient(cfg, name);
      const result = await client.listModels();
      const count = Array.isArray(result) ? result.length : Object.keys(result || {}).length;
      return {
        name,
        ok: true,
        count,
        active: cfg.activeProvider === name,
        diagnostics,
        model: diagnostics.model,
        protocol: diagnostics.protocol,
        apiMode: diagnostics.apiMode,
        supportsTools: diagnostics.supportsTools,
        supportsStreaming: diagnostics.supportsStreaming
      };
    } catch (error) {
      return {
        name,
        ok: false,
        error: error.message,
        active: cfg.activeProvider === name,
        diagnostics,
        lastFailure: diagnostics.lastFailure
      };
    }
  }));
  if (flags.json) {
    console.log(JSON.stringify({
      ok: results.every((result) => result.ok),
      activeProvider: cfg.activeProvider || null,
      providers: results
    }, null, 2));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return;
  }
  for (const line of renderTable(results.map((result) => ({
    provider: result.active ? `${result.name} *` : result.name,
    status: result.ok ? badge("ok") : badge("failed"),
    detail: result.ok ? `${result.count} models` : result.error
  })), [
    { key: "provider", label: "provider" },
    { key: "status", label: "status" },
    { key: "detail", label: "detail" }
  ])) console.log(line);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
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
    if (!PERMISSION_PROFILES.includes(profile)) {
      throw new Error(`Profile must be one of: ${PERMISSION_PROFILES.join(", ")}`);
    }
    cfg.permissionProfile = profile;
    applyPermissionProfile(cfg);
  } else if (args[0] === "set" && args[1] === "guard") {
    const key = args[2];
    const value = parseBoolean(args[3]);
    cfg.gitGuard ||= {};
    if (key === "enabled") cfg.gitGuard.enabled = value;
    else if (key === "require-clean") cfg.gitGuard.requireClean = value;
    else throw new Error("Usage: azycode config set guard <enabled|require-clean> <true|false>");
  } else if (args[0] === "set" && args[1] === "compaction") {
    const mode = args[2];
    if (!COMPACTION_MODES.includes(mode)) {
      throw new Error(`Compaction must be one of: ${COMPACTION_MODES.join(", ")}`);
    }
    cfg.compaction = mode;
  } else if (args[0] === "set" && (args[1] === "api-mode" || args[1] === "apiMode")) {
    const mode = args[2];
    if (!["chat", "responses"].includes(mode)) {
      throw new Error("API mode must be one of: chat, responses");
    }
    if (!cfg.activeProvider) throw new Error("No active provider. Run 'azycode login <provider>'.");
    cfg.providers ||= {};
    cfg.providers[cfg.activeProvider] ||= {};
    cfg.providers[cfg.activeProvider].apiMode = mode;
  } else if (args[0] === "set" && args[1] === "sandbox") {
    const key = args[2];
    const value = args[3];
    cfg.sandbox ||= defaultConfig().sandbox;
    if (key === "mode") {
      if (!SANDBOX_MODES.includes(value)) throw new Error(`sandbox.mode must be one of: ${SANDBOX_MODES.join(", ")}`);
      cfg.sandbox.mode = value;
    } else if (key === "network") {
      if (!SANDBOX_NETWORK_MODES.includes(value)) throw new Error(`sandbox.network must be one of: ${SANDBOX_NETWORK_MODES.join(", ")}`);
      cfg.sandbox.network = value;
    } else if (key === "fallback") {
      if (!SANDBOX_FALLBACK_MODES.includes(value)) throw new Error(`sandbox.fallback must be one of: ${SANDBOX_FALLBACK_MODES.join(", ")}`);
      cfg.sandbox.fallbackMode = value;
    } else if (key === "image") {
      if (!value) throw new Error("Usage: azycode config set sandbox image <name>");
      cfg.sandbox.image = value;
    } else if (key === "timeout-ms") {
      const ms = Number(value);
      if (!Number.isFinite(ms) || ms <= 0) throw new Error("sandbox.timeout-ms must be a positive number");
      cfg.sandbox.timeoutMs = Math.floor(ms);
    } else if (key === "readonly-root") {
      cfg.sandbox.readonlyRoot = parseBoolean(value);
    } else {
      throw new Error("Usage: azycode config set sandbox <mode|network|fallback|image|timeout-ms|readonly-root> <value>");
    }
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
    ui.table(sessionListEntries(state.sessions || {}), [
      { key: "id", label: "id" },
      { key: "created", label: "created" },
      { key: "mode", label: "mode" },
      { key: "status", label: "status" },
      { key: "steps", label: "steps" },
      { key: "tools", label: "tools" },
      { key: "duration", label: "duration" },
      { key: "tokens", label: "tokens" },
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
    console.log(formatSessionTranscript(state.sessions[id], { style: "cli" }));
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
  if (action === "resume") {
    const cfg = loadConfig();
    const flags = parseFlags(args.slice(1));
    const tail = args.slice(1);
    const useLast = tail.includes("--last");
    const positional = positionalArgs(tail, ["max-steps"]);
    let sessionId = useLast ? null : positional[0];
    if (!sessionId || sessionId === "--last") {
      const entries = Object.entries(state.sessions || {})
        .sort((a, b) => String(b[1]?.createdAt || "").localeCompare(String(a[1]?.createdAt || "")));
      sessionId = entries[0]?.[0];
    }
    if (!sessionId || !state.sessions?.[sessionId]) throw new Error("No session to resume. Run an agent task first.");
    const selected = state.sessions[sessionId];
    const followUp = (useLast ? positional : positional.slice(positional[0] === sessionId ? 1 : 0)).join(" ")
      || (await interactivePrompt(cfg));
    const conversation = (selected.messages || []).filter((message) => message.role !== "system");
    const maxSteps = resolveAgentMaxSteps(cfg, flags["max-steps"]);
    const skills = parseSkills(args);
    const onEvent = flags.progress
      ? createAgentProgress({ maxSteps, style: "cli", onLine: (line) => console.error(line) })
      : null;
    const result = await runAgentSafe({
      cfg,
      cwd: process.cwd(),
      prompt: followUp,
      mode: selected.mode || cfg.mode,
      maxSteps,
      conversation,
      returnSession: true,
      onEvent,
      includeContext: Boolean(flags.context),
      skills,
      stream: flags.stream ? true : undefined
    }, { cancellable: true });
    if (result === undefined) {
      process.exitCode = 1;
      return;
    }
    console.log(typeof result === "string" ? result : result.content);
    return;
  }
  throw new Error("Usage: azycode session list|show <id>|transcript <id>|export <id> <file>|resume [id|--last] [prompt]");
}

async function execCmd(args) {
  const cfg = loadConfig();
  const flags = parseFlags(args);
  const rawPrompt = positionalArgs(args).join(" ");
  if (!rawPrompt) throw new Error("Usage: azycode exec [--json] [--progress] [--context] \"task\"");
  const { prompt } = resolveAgentPrompt(rawPrompt, process.cwd());
  const maxSteps = resolveAgentMaxSteps(cfg, flags["max-steps"]);
  const skills = parseSkills(args);
  const events = [];
  const onEvent = (event) => {
    events.push(event);
    if (flags.progress && !flags.json) console.error(formatAgentStepLine(event, { maxSteps, style: "cli" }));
  };
  const result = await runAgentSafe({
    cfg,
    cwd: process.cwd(),
    prompt,
    maxSteps,
    onEvent,
    returnSession: true,
    includeContext: Boolean(flags.context),
    skills,
    stream: flags.stream ? true : undefined
  }, { cancellable: true });
  if (result === undefined) {
    process.exitCode = 1;
    if (flags.json) console.log(JSON.stringify({ ok: false, events }, null, 2));
    return;
  }
  if (flags.json) {
    console.log(JSON.stringify({
      ok: true,
      content: result.content,
      sessionId: result.sessionId,
      summary: formatAgentRunSummary(result.events || events, { style: "cli" }),
      events: result.events || events
    }, null, 2));
    return;
  }
  console.log(result.content);
}

async function mcpCmd(args) {
  const cfg = loadConfig();
  const flags = parseFlags(args);
  const positional = positionalArgs(args);
  const action = positional[0] || "list";

  if (action === "list") {
    const rows = listConfiguredMcpServers(cfg);
    if (!rows.length) {
      console.log("No MCP servers configured. Add entries under mcpServers in config.json.");
      return;
    }
    if (flags.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    ui.table(rows, [
      { key: "name", label: "name" },
      { key: "transport", label: "transport" },
      { key: "command", label: "command" },
      { key: "enabled", label: "enabled" }
    ]);
    return;
  }

  if (action === "status") {
    const results = await probeMcpServers(cfg);
    if (flags.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }
    if (!results.length) {
      console.log("No enabled MCP servers configured.");
      return;
    }
    ui.table(results.map((entry) => ({
      name: entry.name,
      ok: entry.ok ? "yes" : "no",
      tools: entry.tools ?? "",
      resources: entry.resources ?? "",
      prompts: entry.prompts ?? "",
      detail: entry.ok ? "" : (entry.error || "")
    })), [
      { key: "name", label: "name" },
      { key: "ok", label: "ok" },
      { key: "tools", label: "tools" },
      { key: "resources", label: "resources" },
      { key: "prompts", label: "prompts" },
      { key: "detail", label: "detail" }
    ]);
    return;
  }

  if (action === "inspect" || action === "resources" || action === "prompts") {
    const name = positional[1];
    if (!name) throw new Error(`Usage: azycode mcp ${action} <name> [--json]`);
    const detail = await inspectMcpServer(name, cfg);
    if (flags.json) {
      if (action === "resources") console.log(JSON.stringify(detail.resources, null, 2));
      else if (action === "prompts") console.log(JSON.stringify(detail.prompts, null, 2));
      else console.log(JSON.stringify(detail, null, 2));
      return;
    }
    if (action === "resources") {
      for (const resource of detail.resources) console.log(`${resource.uri} · ${resource.name || ""}`);
      return;
    }
    if (action === "prompts") {
      for (const prompt of detail.prompts) console.log(`${prompt.name} · ${prompt.description || ""}`);
      return;
    }
    console.log(`${detail.server.name} · ${detail.server.command}`);
    console.log(`tools: ${detail.tools.length}, resources: ${detail.resources.length}, prompts: ${detail.prompts.length}`);
    for (const tool of detail.tools) console.log(`- ${tool.name}: ${tool.description || ""}`);
    return;
  }

  throw new Error("Usage: azycode mcp list|status|inspect <name>|resources <name>|prompts <name> [--json]");
}

function instructionsCmd(args) {
  const cwd = process.cwd();
  if (args.includes("--json")) {
    console.log(JSON.stringify({
      sources: listInstructionSources(cwd),
      text: discoverProjectInstructions(cwd)
    }, null, 2));
    return;
  }
  const sources = listInstructionSources(cwd);
  console.log("Instruction sources:");
  for (const source of sources) console.log(`- ${source}`);
  const text = discoverProjectInstructions(cwd);
  if (text) {
    console.log("");
    console.log(text);
  } else {
    console.log("(no instruction files found — create AGENTS.md or .azycode/rules.md)");
  }
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

function todoCmd(args) {
  const flags = parseFlags(args);
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const action = positional[0] || "list";
  const cwd = process.cwd();

  if (action === "list") {
    const status = flags.status ? (Array.isArray(flags.status) ? flags.status : [flags.status]) : null;
    const items = status ? listTodos(cwd, { status }) : listTodos(cwd);
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else console.log(formatTodoList(items));
    return;
  }
  if (action === "active") {
    const items = listActiveTodos(cwd);
    if (flags.json) console.log(JSON.stringify(items, null, 2));
    else console.log(formatActiveTodos(cwd) || "No active todos.");
    return;
  }
  if (action === "clear") {
    const removed = flags.completed ? clearCompletedTodos(cwd) : clearAllTodos(cwd);
    console.log(flags.completed
      ? `Cleared ${removed} completed/cancelled todo(s).`
      : `Cleared ${removed} todo(s).`);
    return;
  }
  throw new Error("Usage: azycode todo list|active|clear [--json] [--completed] [--status <status>]");
}

async function contextCmd(args) {
  if (args[0] === "pack") {
    const flags = parseFlags(args.slice(1));
    const pack = await contextPack(process.cwd(), {
      maxFiles: flags.maxFiles || flags["max-files"],
      maxBytes: flags.maxBytes || flags["max-bytes"],
      prompt: flags.prompt || ""
    });
    if (flags.json) console.log(JSON.stringify(pack, null, 2));
    else console.log(formatContextPack(pack));
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
  const rawPrompt = positionalArgs(args).join(" ") || await interactivePrompt(cfg);
  const { prompt } = resolveAgentPrompt(rawPrompt, process.cwd());
  const maxSteps = resolveAgentMaxSteps(cfg, flags["max-steps"]);
  const skills = parseSkills(args);
  const onEvent = flags.progress
    ? createAgentProgress({ maxSteps, style: "cli", onLine: (line) => console.error(line) })
    : null;
  const output = await runAgentSafe(
    {
      cfg,
      cwd: process.cwd(),
      prompt,
      maxSteps,
      onEvent,
      includeContext: Boolean(flags.context),
      skills,
      stream: flags.stream ? true : undefined
    },
    { cancellable: true }
  );
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
  const maxConversation = cfg.maxConversationMessages || 40;
  let conversation = [];
  const chatState = {
    cfg,
    conversation,
    maxConversation,
    setMode: (next) => { mode = next; },
    getMode: () => mode,
    setContext: (next) => { includeContext = next; },
    getContext: () => includeContext,
    setProgress: (next) => { progress = next; },
    getProgress: () => progress,
    skills,
    addSkill: (name) => { if (!cfg.skills?.[name]) { console.error(`No skill named ${name}`); return; } chatState.skills = [...chatState.skills, name]; },
    removeSkill: (name) => { chatState.skills = chatState.skills.filter((s) => s !== name); },
    getSkills: () => chatState.skills,
    getConversation: () => conversation,
    setConversation: (next) => { conversation = next; chatState.conversation = next; }
  };
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
  if (mode === "review" && flags.security) {
    const cwd = process.cwd();
    const review = buildSecurityReview(cwd);
    if (flags.json && !hasActiveProvider(cfg)) {
      console.log(JSON.stringify(formatSecurityReviewJson(review), null, 2));
      return;
    }
    if (!flags.json) console.log(formatSecurityReview(review));
    if (!hasActiveProvider(cfg)) {
      if (!flags.json) console.log("\n(No provider configured — local heuristic review only.)");
      return;
    }
    const prompt = securityReviewPrompt(review);
    const result = await runAgentSafe({
      cfg,
      cwd,
      prompt,
      mode: "review",
      maxSteps: resolveAgentMaxSteps(cfg, flags["max-steps"]),
      skills: parseSkills(args),
      includeContext: Boolean(flags.context)
    }, { cancellable: true });
    if (result === undefined) {
      process.exitCode = 1;
      return;
    }
    const modelOutput = typeof result === "string" ? result : result.content;
    if (flags.json) {
      console.log(JSON.stringify({
        ...formatSecurityReviewJson(review),
        modelReview: modelOutput
      }, null, 2));
      return;
    }
    console.log(formatSecurityReviewCombined(review, modelOutput));
    return;
  }
  if (mode === "review" && flags.local) {
    const review = localReview(process.cwd());
    if (flags.json) console.log(JSON.stringify(formatLocalReviewJson(review), null, 2));
    else console.log(formatLocalReview(review));
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
  }, { cancellable: true });
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

async function patchCmd(args) {
  const action = args[0] || "validate";
  const flags = parseFlags(args);
  if (action !== "validate") throw new Error("Usage: azycode patch validate <file> [--json] [--check <command>]");
  const positional = positionalArgs(args, ["check", "file"]);
  const file = positional[1] || flags.file;
  if (!file) throw new Error("Usage: azycode patch validate <file> [--json] [--check <command>]");
  const patch = fs.readFileSync(path.resolve(file), "utf8");
  const checks = flags.check
    ? (Array.isArray(flags.check) ? flags.check : [flags.check])
    : [];
  const report = await validatePatch({
    cwd: process.cwd(),
    patch,
    checks,
    timeoutMs: Number(flags.timeout) > 0 ? Number(flags.timeout) : 120_000
  });
  if (flags.json) console.log(JSON.stringify(report, null, 2));
  else console.log(formatPatchValidationReport(report));
  if (!report.ok) process.exitCode = 1;
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
    const result = await runAgentSafe({ cfg, cwd: process.cwd(), prompt: text, mode: "goal", skills, returnSession: true }, { cancellable: true });
    updateState((done) => {
      done.goals[goalId].status = result !== undefined ? "done" : "stalled";
      done.goals[goalId].finishedAt = new Date().toISOString();
      if (result?.sessionId) done.goals[goalId].sessions.push(result.sessionId);
      return done;
    });
    if (result !== undefined) console.log(typeof result === "string" ? result : result.content);
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
    const result = await runAgentSafe({ cfg, cwd: process.cwd(), prompt, mode: "goal", skills, returnSession: true }, { cancellable: true });
    updateState((done) => {
      done.goals[goalId].status = result !== undefined ? "done" : "stalled";
      done.goals[goalId].finishedAt = new Date().toISOString();
      if (result?.sessionId) done.goals[goalId].sessions.push(result.sessionId);
      return done;
    });
    if (result !== undefined) console.log(typeof result === "string" ? result : result.content);
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
    const cfg = loadConfig();
    const mission = loadMission(args[1]);
    if (args.includes("--json")) {
      console.log(JSON.stringify(buildMissionDryRun(mission, cfg), null, 2));
      return;
    }
    console.log(formatMissionPlan(mission, cfg));
    return;
  }
  if (args[0] === "report" && args[1]) {
    const state = loadState();
    const selected = state.missions?.[args[1]];
    if (!selected) throw new Error(`No mission ${args[1]}`);
    console.log(formatMissionReport(args[1], selected));
    return;
  }
  if (args[0] !== "run" || !args[1]) throw new Error("Usage: azycode mission run ./mission.yml [--progress] [--context] [--skill <name>]");
  const cfg = loadConfig();
  const runArgs = args.slice(1);
  const flags = parseFlags(runArgs.slice(1));
  const skills = parseSkills(runArgs);
  const onEvent = flags.progress
    ? createAgentProgress({ maxSteps: resolveAgentMaxSteps(cfg), style: "cli", onLine: (line) => console.error(line) })
    : null;
  try {
    const result = await withAgentAbort(async (signal) => runMission({
      cfg,
      cwd: process.cwd(),
      file: args[1],
      skills,
      includeContext: Boolean(flags.context),
      onEvent,
      progressStyle: "cli",
      signal
    }), {
      onCancel: () => console.error("Cancelling mission… (Ctrl+C again to exit)")
    });
    console.log(`Mission ${result.missionId} completed.`);
    for (const step of result.outputs) {
      console.log(`\n# Step ${step.index}\n${step.output}`);
    }
  } catch (error) {
    if (error instanceof AgentCancelledError) {
      console.error("Mission cancelled.");
      process.exitCode = 1;
      return;
    }
    throw error;
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
    const system = flags.system || await ask(
      "System prompt",
      [
        "You are a focused Azycode subagent with a narrow scope.",
        "Inspect before acting, keep changes minimal, cite file paths, and report verification results.",
        "Do not expand beyond the assigned task."
      ].join(" ")
    );
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
    const output = await runAgentSafe({ cfg, cwd: process.cwd(), prompt, subagent: selected, skills }, { cancellable: true });
    if (output === undefined) {
      process.exitCode = 1;
      return;
    }
    console.log(output);
    return;
  }
  if (action === "spawn") {
    const cfg = loadConfig();
    const jsonFlag = args.indexOf("--json");
    let tasks = [];
    if (jsonFlag >= 0) {
      const payload = args[jsonFlag + 1];
      if (!payload) throw new Error("Usage: azycode subagent spawn --json '<tasks-json>'");
      tasks = JSON.parse(payload);
    } else {
      const name = args[1];
      const prompt = args.slice(2).join(" ");
      if (!name || !prompt) throw new Error("Usage: azycode subagent spawn <agent> \"prompt\" or --json '[{agent,prompt}]'");
      tasks = [{ agent: name, prompt }];
    }
    const flags = parseFlags(args);
    const results = await runSubagentsParallel({
      cfg,
      cwd: process.cwd(),
      tasks,
      maxParallel: cfg.maxParallelSubagents,
      maxStepsPerAgent: cfg.subagentMaxSteps
    });
    console.log(formatSubagentResults(results, { json: Boolean(flags.json) }));
    if (results.some((result) => !result.ok)) process.exitCode = 1;
    return;
  }
  throw new Error("Usage: azycode subagent list|add|remove|run|spawn");
}

function hooksCmd(args = []) {
  const cfg = loadConfig();
  const hooks = loadHookConfig(cfg, process.cwd());
  if (args.includes("--json")) {
    console.log(JSON.stringify(hooks, null, 2));
    return;
  }
  ui.title("Hooks");
  const rows = [];
  for (const [event, handlers] of Object.entries(hooks)) {
    if (!Array.isArray(handlers) || !handlers.length) continue;
    for (const handler of handlers) {
      const command = typeof handler === "string" ? handler : handler?.command;
      if (!command) continue;
      rows.push({ event, command });
    }
  }
  if (!rows.length) {
    console.log("No hook handlers configured.");
    console.log(`Global: ${path.join(process.env.AZYCODE_HOME || path.join(os.homedir(), ".azycode"), "hooks.json")}`);
    console.log(`Project: ${path.join(process.cwd(), ".azycode", "hooks.json")}`);
    return;
  }
  ui.table(rows, [
    { key: "event", label: "event" },
    { key: "command", label: "command" }
  ]);
}

function commandsCmd(args = []) {
  const flags = parseFlags(args);
  const positional = positionalArgs(args);
  const action = positional[0] || "list";
  const cwd = process.cwd();

  if (action === "preview") {
    const line = positional.slice(1).join(" ").trim();
    if (!line) throw new Error("Usage: azycode commands preview <name> [args] [--json]");
    const preview = previewCustomCommand(line.startsWith("/") ? line : `/${line}`, cwd);
    if (!preview) throw new Error("Command not found.");
    if (flags.json) {
      console.log(JSON.stringify(preview, null, 2));
      return;
    }
    console.log(`/${preview.name}${preview.args ? ` ${preview.args}` : ""}`);
    console.log("");
    console.log(preview.prompt);
    return;
  }

  const commands = loadCustomCommands(cwd);
  if (commands.errors?.length) {
    for (const error of commands.errors) console.error(warnText(error));
  }
  if (flags.json) {
    console.log(JSON.stringify(commands, null, 2));
    return;
  }
  ui.title("Custom commands");
  if (!commands.length) {
    console.log("No custom commands found.");
    console.log(`Global: ${path.join(process.env.AZYCODE_HOME || path.join(os.homedir(), ".azycode"), "commands")}`);
    console.log(`Project: ${path.join(cwd, ".azycode", "commands")}`);
    return;
  }
  ui.table(commands.map((command) => ({
    name: `/${command.name}`,
    scope: command.scope || "",
    description: command.description || ""
  })), [
    { key: "name", label: "command" },
    { key: "scope", label: "scope" },
    { key: "description", label: "description" }
  ]);
}

async function skills(args) {
  const flags = parseFlags(args);
  const positional = positionalArgs(args, ["description", "text", "scope", "file", "to"]);
  const action = positional[0] || "list";
  const cwd = process.cwd();
  const cfg = loadConfig();

  if (action === "list") {
    const items = listAllSkills(cfg, cwd);
    if (flags.json) {
      console.log(JSON.stringify(items, null, 2));
      return;
    }
    ui.title("Skills");
    if (!items.length) {
      console.log(muted("No skills configured. Add one with: azycode skills add <name>"));
      return;
    }
    ui.table(items.map((skill) => ({
      name: skill.name,
      scope: skill.scope || "",
      description: skill.description || "",
      activation: skill.activation?.join(", ") || ""
    })), [
      { key: "name", label: "name" },
      { key: "scope", label: "scope" },
      { key: "description", label: "description" },
      { key: "activation", label: "activation" }
    ]);
    return;
  }
  if (action === "add") {
    const name = positional[1] || await ask("Name");
    const description = flags.description || await ask("Description", "");
    const text = flags.text || await ask("Skill text", "");
    if (flags.scope === "project") {
      writeProjectSkill(cwd, { name, description, text });
      console.log(`Project skill ${name} added.`);
      return;
    }
    addSkill({ name, description, text });
    console.log(`Skill ${name} added.`);
    return;
  }
  if (action === "remove") {
    const scope = flags.scope === "project" ? "project" : "global";
    removeSkill(positional[1], { scope, cwd });
    console.log(`Skill ${positional[1]} removed.`);
    return;
  }
  if (action === "show") {
    const skill = getSkillRecord(positional[1], cfg, cwd);
    if (!skill) throw new Error(`No skill named ${positional[1]}.`);
    const activation = skill.activation?.length ? ` · activates: ${skill.activation.join(", ")}` : "";
    console.log(`${bold(skill.name)}${skill.scope ? ` [${skill.scope}]` : ""}${skill.description ? ` · ${muted(skill.description)}` : ""}${activation}`);
    console.log("");
    console.log(skill.text || muted("(empty)"));
    return;
  }
  if (action === "export") {
    const name = positional[1];
    if (!name) throw new Error("Usage: azycode skills export <name> [--to <file>]");
    const file = flags.to || flags.file;
    const output = exportSkill(name, { cfg, cwd, file });
    if (file) console.log(`Exported ${name} to ${file}`);
    else console.log(output);
    return;
  }
  if (action === "import") {
    const file = positional[1] || flags.file;
    if (!file) throw new Error("Usage: azycode skills import <file> [--scope global|project]");
    const imported = importSkill(file, { scope: flags.scope, cwd });
    console.log(`Imported skill ${imported.name}.`);
    return;
  }
  throw new Error("Usage: azycode skills list|add|remove|show|export|import [--json] [--scope project]");
}

async function keys(args) {
  if (args[0] !== "shortcuts") return help();
  console.log([
    "Composer shortcuts (TTY prompt reader):",
    "  Tab            rotate reasoning",
    "  Shift+Tab      rotate mode",
    "  Shift+Enter    insert newline",
    "  Ctrl+D         insert newline",
    "  Ctrl+C         cancel input",
    "  Ctrl+U         clear line",
    "  Ctrl+L         redraw screen",
    "  /              open slash command palette",
    "  ↑/↓            pick palette item when typing /commands",
    "",
    "Agent run:",
    "  Ctrl+C         cancel current agent run (press twice to exit)"
  ].join("\n"));
}

async function interactivePrompt(cfg) {
  if (!process.stdin.isTTY) return fs.readFileSync(0, "utf8").trim();
  const banner = `[mode=${cfg.mode} reasoning=${cfg.reasoning}] Enter task, Enter to run, Shift+Enter for newline`;
  const text = await readMultilinePrompt({
    input,
    output,
    banner,
    onShortcut: (key) => {
      if (key.shift) cfg.mode = rotateMode(cfg.mode);
      else cfg.reasoning = rotateReasoning(cfg.reasoning);
      output.write(`\n[mode=${cfg.mode} reasoning=${cfg.reasoning}]\n`);
    },
    onExit: () => process.exit(130)
  });
  saveConfig(cfg);
  return text;
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
  const events = [];
  const progress = createAgentProgress({
    maxSteps,
    style: "cli",
    onLine: (line, event) => {
      events.push(event);
      console.error(line);
      if (event?.type === "agent_run_end") {
        console.error(`summary: ${formatAgentRunSummary(events, { style: "cli" })}`);
      }
    }
  });
  return progress;
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

function resolveAgentPrompt(rawPrompt, cwd = process.cwd()) {
  const custom = rawPrompt.startsWith("/") ? resolveCustomCommand(rawPrompt, cwd) : null;
  const text = custom ? custom.prompt : rawPrompt;
  return expandFileReferences(text, cwd);
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
  if (command === "new") {
    state.setConversation([]);
    console.log("conversation cleared");
    return;
  }
  if (command === "compact") {
    const before = state.getConversation().length;
    const keepRecent = Math.max(8, Math.floor((state.maxConversation || 40) * 0.5));
    if (state.cfg.compaction === "llm" && !hasActiveProvider(state.cfg)) {
      state.setConversation(trimConversation(state.getConversation(), keepRecent));
      console.log("llm compaction requires an active provider; trimmed instead.");
      console.log(`conversation: ${before} -> ${state.getConversation().length} messages`);
      return;
    }
    if (state.cfg.compaction === "llm") {
      try {
        const client = new LlmClient(state.cfg);
        const compacted = await compactConversationWithModel({
          client,
          messages: state.getConversation(),
          model: state.cfg.activeModel,
          keepRecent
        });
        state.setConversation(compacted);
        console.log(`conversation: ${before} -> ${compacted.length} messages (llm)`);
      } catch (error) {
        state.setConversation(trimConversation(state.getConversation(), keepRecent));
        console.log(`llm compact failed (${error.message}); trimmed to ${state.getConversation().length}`);
      }
    } else if (state.cfg.compaction === "deterministic") {
      const compacted = compactConversationDeterministic(state.getConversation(), {
        keepRecent,
        todoState: formatActiveTodos(state.cwd)
      });
      state.setConversation(compacted);
      console.log(`conversation: ${before} -> ${compacted.length} messages (deterministic)`);
    } else {
      state.setConversation(trimConversation(state.getConversation(), keepRecent));
      console.log(`conversation: ${before} -> ${state.getConversation().length} messages`);
    }
    return;
  }
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
    console.log("Slash commands: /mode, /reasoning, /context, /progress, /review, /status, /skill, /compact, /new, /exit");
    return;
  }
  const custom = resolveCustomCommand(line, process.cwd());
  if (custom) {
    await handleChatLine(custom.prompt, state, { skipSlash: true });
    return;
  }
  console.log(`Unknown slash command: /${command}`);
}

async function handleChatLine(line, state, { skipSlash = false } = {}) {
  if (!skipSlash && line.startsWith("/")) return handleChatCommand(line, state);
  const { prompt } = expandFileReferences(line, process.cwd());
  const maxSteps = resolveAgentMaxSteps(state.cfg);
  const result = await runAgentSafe({
    cfg: state.cfg,
    cwd: process.cwd(),
    prompt,
    mode: state.getMode(),
    maxSteps,
    includeContext: state.getContext(),
    conversation: state.getConversation(),
    returnSession: true,
    onEvent: state.getProgress() ? progressPrinter(maxSteps) : null,
    skills: state.getSkills()
  }, { cancellable: true });
  if (result && typeof result === "object") {
    state.setConversation(trimConversation(
      result.messages.filter((message) => message.role !== "system"),
      state.maxConversation
    ));
    console.log(result.content);
  }
}
