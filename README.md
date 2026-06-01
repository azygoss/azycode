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
azycode login zai-coding
azycode login minimax
azycode login opencode-go
azycode login byok
```

API keys are stored in `~/.azycode/config.json` with file mode `0600`. You can override the config directory with `AZYCODE_HOME=/path/to/config`.

## Core commands

```sh
azycode
azycode status
azycode dashboard
azycode help mission
azycode models
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

Run `azycode` without arguments to open the interactive terminal workspace. Type a task directly, or use slash commands such as `/status`, `/dashboard`, `/login`, `/mode`, `/reasoning`, `/context`, `/progress`, `/review`, `/clear`, and `/exit`.

Inside the terminal workspace, `Tab` rotates reasoning effort and `Shift+Tab` rotates mode. The prompt always shows the active mode and reasoning level.

Use `azycode doctor` to confirm which binary you are running while developing. If another global `azycode` exists on `PATH`, run this project directly with `node ./bin/azycode.js ...` or use `npm link` from this directory.

`azycode dashboard` is the fastest local overview. It does not call provider APIs; it shows mode, model, guard state, local state counts, and tool-policy totals.

List commands such as `azycode goal status`, `azycode mission list`, and `azycode session list` use compact tables by default. Add `--json` when a script needs structured output.

Shell completion can be installed with the output of `azycode completion <bash|zsh|fish>`. For example, zsh users can add the generated script to an fpath completion file or source it from their shell profile.

`azycode report [file]` creates a redacted diagnostic bundle with doctor output, config without raw keys, git/repository context, local review findings, and recent tool-run metadata. Add `--with-audit` when you want the report to include the same checks as `azycode audit`.

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
- Kimi: preset uses Moonshot's OpenAI-compatible endpoint.
- Z.AI Coding Plan: preset uses the Coding Plan OpenAI-compatible endpoint.
- MiniMax: preset uses the OpenAI-compatible endpoint.
- OpenCode Go: preset supports the Go `chat/completions` models. Go models served through Anthropic `messages` are represented in docs but need a future Anthropic adapter.
- Status: `azycode status` verifies the active provider through `/models` when available. Exact remaining subscription limits are not standardized across providers; OpenCode Go documents $12/5-hour, $30/week, and $60/month limits, while other providers generally require their dashboards for exact remaining quota.

## Safety

`always-approve` skips interactive tool confirmation, but it does not bypass git guard. By default, write-like tools are blocked on `main` and `master`; work on a feature branch or explicitly change guard settings.

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
