# Azycode API Reference

This document describes the public API of each module under `src/`. Azycode is
an ES-module, zero-dependency Node.js (>=20) CLI. Every module is importable
from other modules or from tooling; functions documented here are the stable
surface used by the CLI, the TUI, missions, subagents, and tests.

For the runtime architecture, see [ARCHITECTURE.md](../ARCHITECTURE.md).
For troubleshooting, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

---

## Table of contents

- [Config & state — `config.js`](#config--state--configjs)
- [Permission profiles — `permissions.js`](#permission-profiles--permissionsjs)
- [Path guard — `path-guard.js`](#path-guard--path-guardjs)
- [Shell risk — `shell-risk.js`](#shell-risk--shell-riskjs)
- [Tools — `tools.js`](#tools--toolsjs)
- [LLM client — `llm.js`](#llm-client--llmjs)
- [MCP — `mcp.js`](#mcp--mcpjs)
- [Context packs — `context.js`](#context-packs--contextjs)
- [Agent loop — `agent.js`](#agent-loop--agentjs)
- [Subagents — `subagents.js`](#subagents--subagentsjs)
- [Missions — `missions.js`](#missions--missionsjs)
- [Skills — `skills.js`](#skills--skillsjs)
- [Custom commands — `commands.js`](#custom-commands--commandsjs)
- [Security review — `security-review.js`](#security-review--security-reviewjs)
- [Patch validation — `patch-validation.js`](#patch-validation--patch-validationjs)
- [Execution policy & sandbox — `execution-policy.js`](#execution-policy--sandbox--execution-policyjs)
- [Local review — `local-review.js`](#local-review--local-reviewjs)
- [Compaction — `compaction.js`](#compaction--compactionjs)
- [Memory — `memory.js`](#memory--memoryjs)
- [Hooks — `hooks.js`](#hooks--hooksjs)
- [UI layer — `ui/ansi.js`, `ui/layout.js`, `ui/cost.js`, `ui.js`](#ui-layer)
- [TUI commands — `tui/commands.js`](#tui-commands--tuicommandsjs)

---

## Config & state — `config.js`

Persists config, state, and todos under `~/.azycode` (override with `AZYCODE_HOME`).
Files are written `0600`; in-memory caches invalidate on mtime.

| Export | Description |
| --- | --- |
| `defaultConfig()` | Return the validated default config object. |
| `validateConfig(cfg)` | Normalize modes, reasoning, profiles, sandbox, and tool policies to safe defaults. |
| `loadConfig()` / `saveConfig(cfg)` | Read/write `config.json` (cached). |
| `loadState()` / `saveState(state)` / `updateState(mutator, {retries})` | Atomic read-modify-write of `state.json`. |
| `loadTodos()` / `saveTodos(todos)` | Read/write `todos.json`. |
| `atomicWriteJson(targetPath, value)` | Atomic JSON write via random-suffix temp file + rename. |
| `resolveAgentMaxSteps(cfg, override)` | Positive step cap or `null` for unlimited. |
| `rotateMode(current)` / `rotateReasoning(current)` | Cycle to the next value. |
| `maskSecret(value)` | Redact a secret to `sk-a…ijkl` form. |
| `DEFAULT_MODE`, `MODES`, `REASONING_LEVELS`, `COMPACTION_MODES` | Constants. |

---

## Permission profiles — `permissions.js`

Maps profiles to per-tool approval rules and resolves runtime decisions.

| Export | Description |
| --- | --- |
| `PERMISSION_PROFILES` | `normal`, `read-only`, `plan-only`, `safe-write`, `trusted-workspace`, `full-auto`. |
| `applyPermissionProfile(cfg)` | Mutate `cfg.toolPolicy` to match the active profile. |
| `resolveToolPermission(cfg, toolName, context)` | Return `{ allowed, decision, rule }` for a tool call. |
| `toolCategory(toolName)` / `profileCategoryPolicy(profile, category)` | Categorization helpers. |
| `describePermissionProfile(profile)` | Human-readable profile summary. |

---

## Path guard — `path-guard.js`

Protects sensitive paths and enforces workspace containment for write tools.

| Export | Description |
| --- | --- |
| `normalizeWorkspacePath(root, requested, {resolveSymlinks})` | Lexical + optional symlink-resolved containment check. |
| `isProtectedWritePath(relPath, cfg)` | Match against `.git`, `.env`, lockfiles, CI workflows, etc. |
| `evaluateWritePath(root, requested, cfg, options)` | Combine containment + protection into `allowed`/`null`/`false`. |
| `assertWritePathAllowed(root, requested, cfg, options)` | Throw if not allowed. |
| `extractUnifiedDiffPaths(patch)` | Extract `b/` destinations from a unified diff. |
| `assertPatchPathsAllowed(root, patch, cfg, options)` | Assert all patch destinations are writable. |

---

## Shell risk — `shell-risk.js`

Classifies shell commands and resolves execution policy.

| Export | Description |
| --- | --- |
| `classifyShellCommand(command)` | Operator-aware classification into one of `SHELL_RISK_LEVELS`. |
| `detectShellOperators(command)` | Detect `\|`, `>`, `>>`, `<`, `$()` and report redirect targets. |
| `evaluateShellPolicy(command, cfg)` | Return `{ decision, level, reason, classification }`. |

---

## Tools — `tools.js`

Builds the filesystem/search/patch/shell/git tool array exposed to the model.

| Export | Description |
| --- | --- |
| `createTools({ cwd, cfg, resolveCfg, confirmTool, modeRuntime, onApproval, subagentSpawner, journalHook })` | Returns the tool array with `.run` async handlers. |
| `toolCatalog({ cwd, cfg })` | Static catalog metadata for help/diagnostics. |

Tools: `list_files`, `read_file`, `read_many_files`, `file_info`, `search`,
`write_file`, `edit_file`, `apply_patch`, `delete_path`, `shell`, `git_diff`,
`git_worktree`, `todo`, `set_mode`, `spawn_subagents`.

---

## LLM client — `llm.js`

OpenAI-compatible Chat Completions + Anthropic Messages normalization.

| Export | Description |
| --- | --- |
| `LlmClient` | Wraps provider config; `chat()` with timeout, retry, streaming, abort. |
| `formatProviderHttpError(provider, status, body)` | Human-readable HTTP error. |
| `applyReasoning(body, reasoning)` | Inject reasoning-effort params per provider. |
| `assistantMessageFromCompletion(completion)` | Extract assistant text + tool calls. |
| `toAnthropicTool` / `toAnthropicMessages` / `fromAnthropicMessage` | Cross-format normalization. |

---

## MCP — `mcp.js`

Stdio JSON-RPC MCP client with tool policy and security hardening.

| Export | Description |
| --- | --- |
| `validateMcpServerCommand(command)` | Reject empty / shell-metachar commands. |
| `normalizeMcpServer(name, server)` | Defaults + dangerous-env stripping (`LD_PRELOAD`, `NODE_OPTIONS`, …). |
| `buildMcpServerEnv(server)` | Allowlist env, never forward injection vectors. |
| `isMcpServerAllowed(server, toolName)` | Enforce allow/deny tool policy. |
| `McpStdioClient` | Lifecycle: `start`, `listTools/Resources/Prompts`, `callTool`, `close` (SIGTERM→SIGKILL). |
| `createMcpTools(cfg)` | Start servers, return `{ tools, warnings, close }`. |
| `probeMcpServers(cfg)` / `inspectMcpServer(name, cfg)` | Diagnostics. |

---

## Context packs — `context.js`

Layered retrieval with byte budgets, injection hardening, and cache invalidation.

| Export | Description |
| --- | --- |
| `repoSnapshot(cwd)` | `{ root, package, git, files, configFiles }`. |
| `formatSnapshot(snapshot)` | Readable summary string. |
| `ContextBuilder` | Collect candidates from snapshot/prompt/neighbors/search; `build()` ranks them. |
| `contextPack(cwd, options)` | Assemble the pack (cached on mtime + mutation generation). |
| `formatContextPack(pack)` | Wrap in `<context-pack>` with `<untrusted-data>` marker. |
| `notifyContextWorkspaceMutation(kind, detail)` | Bump generation, invalidate cache. |
| `shouldInvalidateContextForShell(command)` | Detect mutating shell commands. |
| `extractJsSymbols(content)` | Export names for neighbor retrieval. |

---

## Agent loop — `agent.js`

The core coding-harness loop.

| Export | Description |
| --- | --- |
| `runAgent({ cfg, cwd, prompt, mode, maxSteps, conversation, skills, signal, subagentDepth, ... })` | Run to a final assistant message; emits events; persists sessions. |
| `systemForMode(mode)` | Mode-specific system prompt. |

Throws `AgentStepLimitError` / `AgentCancelledError` (from `agent-errors.js`).

---

## Subagents — `subagents.js`

Parallel subagent sessions with optional worktree isolation.

| Export | Description |
| --- | --- |
| `runSubagentsParallel({ cfg, cwd, tasks, maxParallel, maxStepsPerAgent, subagentDepth, ... })` | Batched parallel runs. |
| `prepareSubagentWorkspace({ cfg, cwd, agentName, sessionId })` | Returns `{ cwd, isolation, worktree, cleanup }`. |
| `addSubagent` / `removeSubagent` / `listSubagents` | Registry management. |
| `assessSubagentConfidence` / `inferSubagentVerification` | Result scoring. |
| `formatSubagentResults(results, { json })` | Report formatting. |

---

## Missions — `missions.js`

JSON/YAML mission DAGs with dependencies and parallel groups.

| Export | Description |
| --- | --- |
| `loadMission(file)` | Parse `.json`/`.yml`/`.yaml`. |
| `validateMission(mission, cfg)` | Schema + cycle check. |
| `buildMissionDryRun(mission, cfg)` | Ordered steps, risk, permissions. |
| `runMission({ cfg, cwd, file, ... })` | Execute sequentially / parallel groups. |
| `missionPlan` / `formatMissionPlan` | Ordering + rendering. |

---

## Skills — `skills.js`

Global and project skills with activation rules.

| Export | Description |
| --- | --- |
| `addSkill` / `removeSkill` / `listSkills` / `listAllSkills` | CRUD + listing. |
| `writeProjectSkill` / `listProjectSkills` | `.azycode/skills/*.md`. |
| `resolveActiveSkills(cfg, cwd, { prompt, explicit })` | Keyword activation matching. |
| `getSkillText(cfg, names, { cwd, prompt })` | Rendered skill text for injection. |
| `exportSkill` / `importSkill` | JSON portability. |

---

## Custom commands — `commands.js`

Markdown slash commands with `{{args}}` expansion.

| Export | Description |
| --- | --- |
| `loadCustomCommands(cwd)` / `clearCustomCommandsCache()` | Discover from `~/.azycode/commands` + `.azycode/commands`. |
| `expandCommandArgs(template, args)` | `{{args}}` substitution. |
| `previewCustomCommand(line, cwd)` / `resolveCustomCommand(line, cwd)` | Resolve + render. |

---

## Security review — `security-review.js`

Combines local heuristics with test recommendations and model review.

| Export | Description |
| --- | --- |
| `buildSecurityReview(cwd)` | Local findings + recommended tests. |
| `recommendSecurityTests(files)` | Map changed files to suggested test commands. |
| `securityReviewPrompt(review)` | Prompt for model-backed review. |
| `formatSecurityReview(review)` / `formatSecurityReviewJson(review)` | Output formatting. |

---

## Patch validation — `patch-validation.js`

Applies patches in an isolated worktree and runs optional checks.

| Export | Description |
| --- | --- |
| `validatePatch({ cwd, patch, checks, cfg, timeoutMs, signal })` | Returns `{ ok, mode, worktree, changedFiles, checks, ... }`. |
| `formatPatchValidationReport(report)` | Readable report. |

Integrates `assertPatchPathsAllowed` (blocks protected paths) and
`evaluateShellPolicy` (denies destructive checks).

---

## Execution policy & sandbox — `execution-policy.js`

Local/docker/podman backends with env filtering and secret redaction.

| Export | Description |
| --- | --- |
| `resolveExecutionPolicy(cfg, cwd)` | Normalized policy object. |
| `buildContainerArgs(policy, { runtime, command, env })` | Container argv; **rejects sensitive mounts** (`docker.sock`, `/proc`, `/sys`, `/dev`, `/etc`). |
| `resolveShellInvocation(command, cfg, cwd, deps)` | Pick backend (with fallback). |
| `executePreparedShell(invocation, options)` | Run + redact secrets. |
| `filterEnv` / `redactCommand` / `redactShellOutput` | Sanitization. |
| `sandboxStatus(cfg, cwd, deps)` | Runtime availability + effective backend. |

---

## Local review — `local-review.js`

Git-diff heuristic security scan (no provider needed).

| Export | Description |
| --- |--- |
| `localReview(cwd)` | `{ status, files, stats, findings }`. Detects secrets, eval, SSRF, path traversal, CI changes, risky scripts, etc. |
| `formatLocalReview(review)` / `formatLocalReviewJson(review)` | Output formatting. |

---

## Compaction — `compaction.js`

Trims/compacts conversation history.

| Export | Description |
| --- | --- |
| `compactConversationDeterministic(messages, { keepRecent, todoState })` | Rule-based trim. |
| `compactConversationWithModel({ client, messages, model, keepRecent })` | LLM-backed summarization. |

---

## Memory — `memory.js`

Long-lived local notes (cached on mtime).

| Export | Description |
| --- |--- |
| `loadMemory()` / `saveMemory(memory)` | Read/write `memory.json`. |
| `addMemory(text, tags)` / `removeMemory(id)` / `searchMemory(query)` | CRUD + search. |

---

## Hooks — `hooks.js`

Configurable lifecycle hooks (`pre_model`, `post_model`, `pre_tool`, …).

| Export | Description |
| --- | --- |
| `HOOK_EVENTS` | Supported event names. |
| `loadHookConfig(cfg, cwd)` | Merge global + project `.azycode/hooks.json`. |
| `runHooks(event, payload, hooks, { cwd, signal })` | Execute; supports `{ block, modify }`. |

---

## UI layer

Rendered in a dependency-free terminal style. Layered (plan.md §2.4):

- **`src/ui/ansi.js`** — `colorsEnabled`, `ANSI`, `namedColors`, `style`, `paint`,
  semantic color shortcuts (`muted`, `success`, …), width helpers
  (`visibleLength`, `padEnd`, `padStart`, `truncate`, `stripAnsi`, `sliceVisible`,
  `skipVisible`), and `wrapText`.
- **`src/ui/layout.js`** — `modeColor`, `FRAME`, `rule`, `frame`, `box`, `panel`.
- **`src/ui/cost.js`** — `MODEL_PRICING`, `estimateCost`, `formatUSD`,
  `costColor`, `costDisplay`, `costSummaryPanel`.
- **`src/ui.js`** — higher-level components (welcome screen, tool cards, diff
  blocks, error/session panels) that re-export the three layers above.

All exports of the three sub-layers are re-exported from `src/ui.js`, so existing
`import { ... } from "./ui.js"` call sites keep working.

---

## TUI commands — `tui/commands.js`

The declarative command catalog and dispatch registry (plan.md §2.3).

| Export | Description |
| --- | --- |
| `TUI_COMMANDS` | Canonical built-in slash-command names. |
| `COMMAND_ALIASES` | `quit`→`exit`, `?`→`help`, etc. |
| `TOOL_POLICY_MODES` | `["auto", "ask", "deny"]`. |
| `helpGroups()` | Grouped `[command, description]` layout for `/help` and the palette. |
| `registerCommand(name, handler)` | Add a handler to the registry. |
| `resolveCommandName(command)` | Apply aliases → canonical name (or `null`). |
| `dispatchCommand(command, args, state, rl, promptSession)` | Invoke a registered handler. |
