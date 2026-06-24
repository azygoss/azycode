// src/tui/commands.js
// TUI command registry: the declarative catalog of slash commands, their
// aliases, help-group layout, and a dispatch table scaffold.
//
// Previously these definitions were inlined in tui.js (2195 lines). Extracting
// them here (see plan.md §2.3) separates the *what* (command metadata) from the
// *how* (handler bodies, which still live in tui.js next to the shared state
// they mutate). Handlers register themselves into the registry at launch.

/** Tool-policy values accepted by /tool and /policy. */
export const TOOL_POLICY_MODES = ["auto", "ask", "deny"];

/**
 * Canonical list of built-in slash commands. Used for palette filtering,
 * tab-completion, and collision detection against custom commands.
 */
export const TUI_COMMANDS = [
  "help", "status", "health", "doctor", "dashboard", "sessions", "tools", "goals", "missions", "mission",
  "session", "resume", "policy", "tool", "memory", "agents", "agent", "providers", "provider", "login", "mode", "reasoning",
  "model", "models", "profile", "credentials", "keys", "workspace", "context", "progress", "stream", "instructions", "review", "skill", "todo", "new", "compact", "hooks", "commands", "cost", "clear", "reload", "exit", "quit"
];

/** Short aliases that resolve to a canonical command name. */
export const COMMAND_ALIASES = {
  quit: "exit",
  q: "exit",
  "?": "help",
  h: "help",
  models: "model",
  agents: "agent"
};

/**
 * Help-group layout for /help and the command palette. Each group renders a
 * titled section of [command, description] pairs. This is pure data so it can
 * be reused by palette filtering, completion, and docs generation.
 * @returns {Array<{title:string,items:Array<[string,string]>}>}
 */
export function helpGroups() {
  return [
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
      ["/mode", "plan, build, always-approve, goal, review"],
      ["/reasoning", "minimal, low, medium, high"],
      ["/profile", "permission profile"],
      ["/context", "toggle repository context"],
      ["/instructions", "show active AGENTS.md sources"],
      ["/stream", "toggle response streaming"],
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
      ["/resume", "resume a saved session"],
      ["/tools", "recent tool activity"],
      ["/goals", "saved goals"],
      ["/missions", "saved missions"],
      ["/todo", "manage workspace todos"],
      ["/skill", "list, add, remove skills"],
      ["/cost", "session token cost summary"]
    ]},
    { title: "Other", items: [
      ["/mission", "dry-run, run, report"],
      ["/memory", "manage notes"],
      ["/keys", "keyboard shortcuts"],
      ["/new", "start a fresh conversation"],
      ["/compact", "trim or llm-compact context"],
      ["/hooks", "show lifecycle hook handlers"],
      ["/commands", "list custom slash commands"],
      ["/reload", "re-read config and refresh"],
      ["/clear", "redraw the screen"],
      ["!<cmd>", "run a shell command in the workspace"],
      ["/exit", "leave azycode"]
    ]}
  ];
}

/**
 * Command registry: maps canonical command names to async handler functions.
 * Handlers receive `(args, state, rl, promptSession)` and return "exit" to
 * terminate the TUI loop, or any other value (typically undefined) to continue.
 *
 * The registry starts empty and is populated by `registerTuiCommands()` at
 * launch, so handler bodies can stay co-located with the tui.js state they use.
 */
export const COMMAND_HANDLERS = new Map();

/**
 * Register a handler for a canonical command name.
 * @param {string} name - Canonical command name (must be in TUI_COMMANDS).
 * @param {(args:string[], state:object, rl:object|null, promptSession:object|null) => (Promise<string|undefined>|string|undefined)} handler
 */
export function registerCommand(name, handler) {
  if (!TUI_COMMANDS.includes(name)) {
    throw new Error(`Cannot register unknown command: ${name}`);
  }
  COMMAND_HANDLERS.set(name, handler);
}

/**
 * Resolve a raw command token to its canonical name (applying aliases), or null
 * if the token is not a recognized command.
 * @param {string} command
 * @returns {string|null}
 */
export function resolveCommandName(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return null;
  if (COMMAND_ALIASES[cmd]) return COMMAND_ALIASES[cmd];
  if (TUI_COMMANDS.includes(cmd)) return cmd;
  return null;
}

/**
 * Dispatch a parsed slash command through the registry. Returns the handler
 * result (e.g. "exit"), or a `{ handled: false }` marker when no handler is
 * registered for the command — letting the caller fall back to legacy logic.
 * @param {string} command - Canonical command name.
 * @param {string[]} args - Parsed argument tokens.
 * @param {object} state - TUI session state.
 * @param {object|null} rl - readline interface (may be paused).
 * @param {object|null} promptSession - prompt session handle.
 */
export async function dispatchCommand(command, args, state, rl = null, promptSession = null) {
  const canonical = resolveCommandName(command);
  if (!canonical) return { handled: false };
  const handler = COMMAND_HANDLERS.get(canonical);
  if (!handler) return { handled: false };
  const result = await handler(args, state, rl, promptSession);
  return { handled: true, result };
}
