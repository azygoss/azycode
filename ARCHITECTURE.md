# Azycode Architecture

## Runtime

Azycode is a dependency-free Node.js CLI. The main process owns:

| Module | Responsibility |
| --- | --- |
| `src/cli.js` | Command routing, help topics, interactive prompts |
| `src/agent.js` | Coding harness loop, tool dispatch, session events |
| `src/llm.js` | OpenAI-compatible fetch, timeout, retry, streaming |
| `src/providers.js` | Provider presets, capability registry, diagnostics |
| `src/config.js` | Persisted config/state, validation, caching |
| `src/tools.js` | Filesystem, search, patch, shell, git tools |
| `src/permissions.js` | Permission profiles and per-tool policy resolution |
| `src/path-guard.js` | Protected path checks for write tools |
| `src/shell-risk.js` | Shell command risk classification |
| `src/guard.js` | Git branch guard (main/master protection) |
| `src/execution-policy.js` | Execution policy abstraction |
| `src/sandbox.js` | Optional Docker/Podman/local sandbox backends |
| `src/exec.js` | Cancellable subprocess execution with byte limits |
| `src/context.js` | Layered context retrieval and context packs |
| `src/compaction.js` | Conversation trimming and deterministic/LLM compaction |
| `src/missions.js` | Mission load/plan/run, schema validation, dry-run |
| `src/subagents.js` | Subagent registry, parallel runs, worktree isolation |
| `src/skills.js` | Global and project skills, activation rules, import/export |
| `src/commands.js` | Markdown custom commands with frontmatter |
| `src/mcp.js` | Stdio MCP clients, tool policy, probe/inspect |
| `src/local-review.js` | Local git-diff security heuristics |
| `src/security-review.js` | Security review orchestration and test recommendations |
| `src/patch-validation.js` | Isolated worktree patch validation |
| `src/memory.js` | Long-lived local notes |
| `src/hooks.js` | Configurable lifecycle hooks |
| `src/bench.js` | Internal benchmark harness |
| `src/tui.js` / `src/ui.js` | Interactive terminal UI |
| `src/harness.js` | Progress formatting, runtime snapshots, abort handling |
| `src/logger.js` | Leveled logging (`AZYCODE_LOG_LEVEL`, `AZYCODE_DEBUG`) |

The CLI entrypoint is `bin/azycode.js`. All runtime behavior lives under this repository's `src/` directory — it is not a wrapper around another harness.

## Config

Default config directory is `~/.azycode`; set `AZYCODE_HOME` to isolate a project, test run, or CI environment.

The CLI stores keys with `0600` file permissions. It does not hardcode user keys and can also read provider-specific environment variables.

Config, state, and todos are loaded with an in-memory cache keyed on file mtime. Config values are validated on load: unknown modes, reasoning levels, permission profiles, sandbox modes, and tool policies are normalized to safe defaults.

Notable config keys:

- `permissionProfile` — `normal`, `read-only`, `plan-only`, `safe-write`, `trusted-workspace`, `full-auto`
- `gitGuard` — enabled by default; blocks writes on `main`/`master`
- `pathGuard` — protects `.git`, `.env`, lockfiles, CI workflows
- `shellPolicy` — destructive/network/secret-risk command handling
- `sandbox` — `mode`, `network`, mounts, env allowlist
- `mcpServers` — stdio MCP server definitions with tool policy
- `subagentIsolation` — `same-workspace` or `worktree`

## Agent Loop

The loop sends:

1. mode-specific system prompt
2. applied skills (explicit or activation-matched)
3. project instructions (`AGENTS.md`, `.azycode/rules.md`)
4. relevant memory and active todos
5. optional context pack
6. user task
7. OpenAI tool schemas
8. structured tool results until the model returns a final assistant message

Risky tools ask for approval unless `alwaysApprove` is enabled or policy is changed. Git guard and path guard are separate from approval and still apply.

Agent runs emit progress events, persist recent tool execution records, and expose formatted transcripts. Optional context packs use layered retrieval with per-section byte budgets and untrusted-data wrapping.

## Missions and Subagents

**Missions** (`src/missions.js`):

- Load `.json`, `.yml`, or `.yaml` mission files
- `validateMission` checks modes, agents, maxSteps, dependencies, and cycles
- `buildMissionDryRun` exposes ordered steps, parallel groups, risk, and permission metadata
- `runMission` executes steps sequentially or in parallel groups, passing context between dependent steps

**Subagents** (`src/subagents.js`):

- Built-in profiles: planner, reviewer, implementer, explorer
- `runSubagentsParallel` batches tasks with depth limits
- Optional `subagentIsolation: worktree` creates isolated git worktrees under `.azycode/worktrees/`
- Results include duration, changed files, verification hints, and confidence

## Extensibility

**Skills** — global entries in config; project entries in `.azycode/skills/*.md`. Skills support `activation` keyword rules and JSON import/export.

**Custom commands** — markdown files in `~/.azycode/commands/` and `.azycode/commands/`. Frontmatter supports `name`, `description`, `scope`, and `args`. Prompts can use `{{args}}`.

**MCP** — stdio JSON-RPC clients with startup/request timeouts, env allowlists, tool allow/deny policy, collision detection, and CLI probe/inspect/resources/prompts commands.

**Hooks** — configured shell commands on agent lifecycle events.

## Review and Security

**Local review** (`local-review.js`) scans git diffs for secrets, injection patterns, SSRF, weak crypto, CI workflow changes, package script risks, and more.

**Security review** (`security-review.js`) combines local findings with test recommendations and an optional model-backed security prompt via `azycode review --security`.

**Patch validation** (`patch-validation.js`) applies patches in an isolated git worktree, runs optional verification commands, and never mutates the main workspace.

## Provider Strategy

The model client supports:

- OpenAI Chat Completions for OpenAI-compatible providers
- OpenAI Responses API when `api-mode` is `responses`
- Anthropic Messages normalization for OpenCode Go models that use `/messages`
- Model-based routing for OpenCode Go, because its documented endpoints differ by model family
- Capability registry and `status`/`health --json` diagnostics

## Testing

`npm test` runs the Node.js built-in test runner (`node --test`). Tests cover CLI flows, agent behavior, permissions, sandbox command builders, MCP fake server fixtures, mission validation, subagent isolation, security review, and patch validation.