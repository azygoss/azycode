# Azycode Architecture

## Runtime

Azycode is a dependency-free Node.js CLI. The main process owns:

- command routing in `src/cli.js`
- provider presets in `src/providers.js`
- persisted configuration and state in `src/config.js`
- OpenAI-compatible model calls in `src/llm.js`
- coding harness loop in `src/agent.js`
- filesystem/shell/git tools in `src/tools.js`
- mission execution in `src/missions.js`
- custom subagent registry in `src/subagents.js`
- repository snapshots in `src/context.js`
- long-lived local notes in `src/memory.js`
- local git-diff review heuristics in `src/local-review.js`
- terminal UI primitives in `src/ui.js`
- interactive TUI in `src/tui.js`
- centralized logging in `src/logger.js`

It is intentionally not a wrapper around any existing local `azy-code` binary or repository. The CLI entrypoint is `bin/azycode.js`, and all runtime behavior lives under this repository's `src/` directory.

## Config

Default config directory is `~/.azycode`; set `AZYCODE_HOME` to isolate a project, test run, or CI environment.

The CLI stores keys with `0600` file permissions. It does not hardcode user keys and can also read provider-specific environment variables.

Config, state, and todos are loaded with an in-memory cache keyed on file mtime to reduce repeated disk reads during a single process. Config values are validated on load: unknown modes, reasoning levels, permission profiles, and tool policies are normalized to safe defaults.

## Agent Loop

The loop sends:

1. mode-specific system prompt
2. user task
3. OpenAI tool schemas
4. tool results until the model returns a final assistant message

Risky tools ask for approval unless `alwaysApprove` is enabled or policy is changed.
Git guard is separate from approval and still blocks protected branches unless disabled.

Plan and review artifacts can be saved with `--save`; sessions are persisted to state and can be exported for debugging or audit trails.
Agent runs emit progress events, persist recent tool execution records, and expose formatted transcripts for review.
Optional context packs gather bounded, ignore-aware source excerpts into the system prompt with `--context`.
The `chat` command provides an interactive loop with slash commands for mode, reasoning, context, progress, local review, and status.

## Provider Strategy

The model client supports:

- OpenAI Chat Completions for OpenAI-compatible providers.
- Anthropic Messages normalization for OpenCode Go models that use `/messages`.
- Model-based routing for OpenCode Go, because its documented endpoints differ by model family.
