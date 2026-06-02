# Azycode

`azycode` is a lightweight AI coding harness CLI for local repositories. It supports provider login, BYOK OpenAI-compatible endpoints, goal mode, missions, custom subagents, review/plan/always-approve modes, reasoning level switching, and model tool calls.

This repository is a standalone implementation. It does not import, shell out to, or wrap any existing `azy-code` or `azycode` installation that may already exist on the machine.

## Install locally

```sh
npm install -g .
```

Or run without global install:

```sh
node ./bin/azycode.js help
```

## Provider setup

```sh
azycode providers
azycode doctor
azycode doctor --json
azycode completion zsh
azycode login kimi
azycode login kimi-api
azycode login zai-coding
azycode login minimax
azycode login opencode-go
azycode login byok
```

API keys are stored in `~/.azycode/config.json` with file mode `0600`. You can override the config directory with `AZYCODE_HOME=/path/to/config`.

## Environment variables

- `AZYCODE_HOME` — override the default config/state directory (`~/.azycode`).
- `AZYCODE_AGENT_MAX_STEPS` — cap agent steps per run (`unlimited`, `0`, or a positive number).
- `AZYCODE_REQUEST_TIMEOUT_MS` — LLM request timeout in milliseconds (default: `60000`).
- `AZYCODE_LOG_LEVEL` — logger level: `debug`, `info`, `warn`, `error` (default: `info`).
- `AZYCODE_DEBUG` — set to `1` or `true` to show full stack traces on CLI errors.
- `NO_COLOR` — disable ANSI colors in output.

## Core commands

```sh
azycode --version
azycode
azycode status
azycode dashboard
azycode help mission
azycode model
azycode model <provider/model>
azycode model sync all
azycode models
azycode models sync
azycode models sync all
azycode models use <model>
azycode models inspect [model]
azycode provider current
azycode health
azycode tools
azycode tools log
azycode guard status
azycode session list
azycode session transcript <id>
azycode session export <id> ./session.json
azycode memory add "Prefer small verified patches" workflow
azycode context
azycode context pack --max-files 40 --max-bytes 80000
azycode audit
azycode report ./azycode-report.json
azycode config set mode plan
azycode config set mode always-approve
azycode config set reasoning high
azycode config set tool shell ask
azycode config set profile safe-write
azycode config set guard enabled false
azycode config toggle always-approve
azycode plan --save ./plan.md "inspect this repo and propose a safe implementation plan"
azycode run --progress --context "inspect this repo and propose a safe implementation plan"
azycode chat
azycode review --local
azycode goal start "add a tested feature"
azycode mission run examples/mission.yml
azycode mission report <id>
azycode subagent list
azycode subagent add security-reviewer
```

Run `azycode` without arguments to open the interactive terminal workspace. Type `/` to show the command palette, type a task directly, or use slash commands such as `/status`, `/health`, `/doctor`, `/dashboard`, `/workspace`, `/sessions`, `/session`, `/tools`, `/policy`, `/goals`, `/goal`, `/missions`, `/mission`, `/memory`, `/agents`, `/agent`, `/providers`, `/provider`, `/credentials`, `/keys`, `/login`, `/new`, `/compact`, `/mode`, `/reasoning`, `/model`, `/models`, `/profile`, `/context`, `/progress`, `/review`, `/clear`, and `/exit`.

Inside the terminal workspace, `Tab` rotates reasoning effort and `Shift+Tab` rotates mode. The prompt always shows the active mode and reasoning level.
Messages in one terminal workspace share conversation and tool context. Use `/compact` to retain only recent context or `/new` when you want a clean conversation. Long conversations are trimmed automatically at user-message boundaries.

Use `/login` inside the terminal workspace to choose a provider from the picker and enter its API key. Preset endpoint and model details are filled automatically; BYOK additionally asks for its custom URL and model. Use `/model` as the main model hub: it shows providers under one Models view, groups every known model by provider, and selecting `provider/model` switches both provider and model together.

Useful inspection commands inside the terminal workspace:

- `/health`, `/status`, and `/doctor` show provider connectivity, active runtime state, and local binary/config paths.
- `/context show` previews the bounded repository context before sending it to a model.
- `/session <id>` and `/mission report <id>` show saved transcripts and mission state.
- `/goal create <text>`, `/goal status [id]`, and `/goal stop <id>` manage local goal records without leaving the TUI.

Use `azycode doctor` to confirm which binary you are running while developing. If another global `azycode` exists on `PATH`, run this project directly with `node ./bin/azycode.js ...` or use `npm link` from this directory.

`azycode dashboard` is the fastest local overview. It does not call provider APIs; it shows mode, model, guard state, local state counts, and tool-policy totals.

List commands such as `azycode goal status`, `azycode mission list`, and `azycode session list` use compact tables by default. Add `--json` when a script needs structured output.

Shell completion can be installed with the output of `azycode completion <bash|zsh|fish>`. For example, zsh users can add the generated script to an fpath completion file or source it from their shell profile.

`azycode report [file]` creates a redacted diagnostic bundle with doctor output, config without raw keys, git/repository context, local review findings, and recent tool-run metadata. Add `--with-audit` when you want the report to include the same checks as `azycode audit`.

Built-in tools cover common repository work: `list_files`, `read_file`, `read_many_files`, `file_info`, `search`, `git_status`, `git_log`, `git_show`, `git_diff`, `git_checkout`, `make_dir`, `write_file`, `edit_file`, `copy_path`, `move_path`, `delete_path`, `apply_patch`, `shell`, `todo`, and `set_mode`. The model can call `set_mode` to switch into `plan` (or back to execution modes) during an agent run, and `todo` to track multi-step work per workspace. Read-only tools default to auto approval; write-like tools default to ask. Optional git guard (disabled by default) can block writes and `shell` on configured branches such as `main` and `master`.

Use `azycode tools` or `/policy` to inspect the full tool catalog. Use `azycode tools inspect <tool>` or `/tool <tool>` to see parameters and required fields.
`read_file` supports bounded reads with `startLine`, `endLine`, `maxBytes`, and optional line numbers.
`search` supports `maxResults` and `contextLines` so large repositories do not flood the model context.

Non-interactive login is supported for scripts:

```sh
azycode login byok --base-url http://127.0.0.1:11434/v1 --model local-model --api-key sk-local
```

## Keyboard shortcuts

In the interactive `azycode run` prompt:

- `Shift+Tab` rotates mode: `plan -> always-approve -> goal -> review`
- `Tab` rotates reasoning: `minimal -> low -> medium -> high`
- `Ctrl+D` submits

## Provider notes

- OpenAI/Codex: ChatGPT subscription login is not an API credential. Use an OpenAI API key or compatible endpoint.
- Kimi Code: `kimi` uses the Kimi Code/Coding Plan endpoint (`https://api.kimi.com/coding/v1`) with model `kimi-for-coding`. This is separate from the standard Moonshot API.
- Kimi API: `kimi-api` uses Moonshot's standard OpenAI-compatible endpoint (`https://api.moonshot.ai/v1`) and API billing.
- Z.AI Coding Plan: preset uses the Coding Plan OpenAI-compatible endpoint.
- MiniMax: preset uses the OpenAI-compatible endpoint.
- OpenCode Go: preset includes the current Go coding model list and routes MiniMax models through the Anthropic `messages` endpoint when required.
- Models: `azycode model sync` or `/model sync` fetches the active provider's remote `/models` list and stores it without dropping saved models. Use `azycode model sync all` or `/model sync all` to refresh every configured provider. The older `models sync` commands remain as aliases.
- Status: `azycode status` verifies the active provider through `/models` when available. Exact remaining subscription limits are not standardized across providers; OpenCode Go documents $12/5-hour, $30/week, and $60/month limits, while other providers generally require their dashboards for exact remaining quota.

## Safety

`always-approve` skips interactive tool confirmation, but it does not bypass git guard when that guard is enabled. Git guard is **off by default**. To block writes and `shell` on `main`/`master`, run `azycode config set guard enabled true`.

## Mission format

`azycode` supports JSON missions and a tiny YAML subset:

```yaml
name: implement-feature
mode: goal
steps:
  - "Read the codebase and make a plan."
  - "Implement the feature."
  - "Run tests and summarize results."
```

Each step is sent through the same agent loop and can use tool calls.

JSON missions can use object steps:

```json
{
  "name": "implementation",
  "mode": "goal",
  "continueOnError": false,
  "steps": [
    { "agent": "planner", "prompt": "Create the implementation plan.", "maxSteps": 6 },
    { "agent": "implementer", "prompt": "Implement the plan.", "mode": "always-approve", "maxSteps": 12 }
  ]
}
```

## Usage examples

### Start a goal and let the agent work autonomously

```sh
azycode goal start "add unit tests for src/logger.js"
```

The agent runs in `goal` mode, makes a plan, executes steps, and writes results to `~/.azycode/goals/`.

### Review local changes before committing

```sh
azycode review --local
```

Shows a diff of uncommitted changes with security heuristics (eval, innerHTML, unsafe shell exec).

### Run a mission file

```sh
azycode mission run examples/mission.yml
```

Missions are reusable step lists. Each step runs through the agent loop with full tool access.

### Switch mode on the fly in the TUI

```sh
azycode
```

Inside the terminal workspace, press `Shift+Tab` to rotate mode (`plan -> always-approve -> goal -> review`) and `Tab` to rotate reasoning effort.

### Debug a provider issue

```sh
azycode doctor
azycode doctor --json
```

Shows provider connectivity, active model, protocol, API key source, and quota notes.

### Export a session transcript

```sh
azycode session list
azycode session transcript <id>
azycode session export <id> ./session.json
```

### Inspect repository context before sending to the model

```sh
azycode context pack --max-files 40 --max-bytes 80000
```

### Non-interactive login for CI/scripts

```sh
azycode login byok --base-url http://127.0.0.1:11434/v1 --model local-model --api-key sk-local
```
```
