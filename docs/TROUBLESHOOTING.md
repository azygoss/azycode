# Azycode Troubleshooting

Common problems, error messages, and their fixes. If something here doesn't
resolve your issue, run `azycode doctor` for a diagnostic snapshot or open an
[issue](https://github.com/azygoss/azycode/issues).

---

## Table of contents

- [Installation & startup](#installation--startup)
- [Provider & model connection](#provider--model-connection)
- [Permissions, guard, and sandbox](#permissions-guard-and-sandbox)
- [MCP servers](#mcp-servers)
- [Missions & subagents](#missions--subagents)
- [TUI & rendering](#tui--rendering)
- [Testing & development](#testing--development)

---

## Installation & startup

### `azycode: command not found` after install

The global bin isn't on your `PATH`. Re-run the install and check the bin path:

```bash
npm install -g .
azycode doctor   # reports PATH realpath and whether the bin resolves
```

If `doctor` can't find it, ensure `npm bin -g` is on your `PATH`. With
[nvm](https://github.com/nvm-sh/nvm), run `nvm use <node>` then reinstall.

### `Error: Node version ... is below required >=20`

Azycode requires Node 20+. Upgrade with `nvm install 20 && nvm use 20`, or your
platform's Node manager.

### Tests hang or print `require is not defined`

You likely ran `node --test` from the repo root and it picked up a stray script.
Use the project script, which scopes discovery to `test/`:

```bash
npm test   # runs: node --test "test/**/*.test.js"
```

---

## Provider & model connection

### `No active provider` / `No active provider: run 'azycode login <provider>'`

No provider is configured. Log in first:

```bash
azycode login openai   # or: kimi, minimax, byok
```

For a self-hosted / OpenAI-compatible endpoint, use BYOK:

```bash
azycode login byok --base-url http://localhost:11434/v1 --model my-model --api-key sk-...
```

### HTTP 401 / `invalid api key`

The configured key is missing, wrong, or expired. Re-run
`azycode login <provider>` to refresh it, or check the relevant env var
(`OPENAI_API_KEY`, `MOONSHOT_API_KEY`, …). Keys are stored `0600` under
`~/.azycode/config.json`.

### HTTP 429 / rate limit

The provider is throttling you. Azycode retries with exponential backoff, but
if it persists: lower concurrency (`config set maxParallelSubagents 2`), reduce
`agentMaxSteps`, or wait for the quota window to reset. Subscription quota is
provider-specific — check the provider dashboard.

### Requests time out

Set a longer timeout if your provider/model is slow:

```bash
export AZYCODE_REQUEST_TIMEOUT_MS=120000   # default 60000
```

Streaming (`config set streamResponses true`) helps avoid full-turn timeouts on
slow first tokens.

### `model ... is stale` / unexpected model used

`activeModel` can drift from the provider's model list after a migration.
`status --json` shows the resolved model. Run `azycode model` to pick a current
one, or `azycode login <provider>` to re-resolve.

---

## Permissions, guard, and sandbox

### `Write to protected path blocked: .env` (or `.git`, lockfiles, CI workflows)

The path guard protects secrets and supply-chain files by default. To proceed
intentionally:

```bash
# Per-write, in always-approve the guard still applies — approve explicitly.
# Or allow a specific class:
azycode config set pathGuard.allowEnv true        # .env writes
azycode config set pathGuard.allowLockfiles true  # lockfile writes
azycode config set pathGuard.allowCiWorkflows true
```

Set `pathGuard.disabled true` only in a throwaway workspace.

### `Git guard: branch main/master is protected`

Writes are blocked on the default branch to prevent accidental pushes.
Create a feature branch first, or disable for trusted workspaces:

```bash
azycode config set gitGuard.enabled false   # only when you understand the risk
```

### `Destructive command blocked`

`shell-risk` classifies `rm -rf`, `git reset --hard`, etc. as destructive. In
`full-auto` you can opt in explicitly:

```bash
azycode config set permissionProfile full-auto
azycode config set shellPolicy.allowDestructive true
```

### `Refusing to mount sensitive host path into container`

`buildContainerArgs` blocks bind-mounts of `/proc`, `/sys`, `/dev`, `/etc`,
`/boot`, and the docker/podman socket. Mount only workspace/cache paths:

```jsonc
{ "sandbox": { "mounts": [{ "source": "/tmp/.cache", "target": "/root/.cache" }] } }
```

### `shell denied by tool policy` / approval loops

Pick a profile that matches your trust level:

```bash
azycode config set profile trusted-workspace   # auto-approve build/test
azycode config set profile full-auto           # auto-approve network too
azycode config set toolPolicy.shell auto       # per-tool override
```

---

## MCP servers

### `MCP server <name> failed to start`

Run the probe to see stderr:

```bash
azycode mcp status --json
azycode mcp inspect <name>
```

Common causes: wrong `command`, missing runtime, or the server crashes on
`initialize`. The `inspect` output includes the server's stderr tail.

### `MCP server command contains forbidden shell metacharacters`

`validateMcpServerCommand` rejects commands containing `; | & $ \` < > ( )` to
prevent injection. Provide the executable directly with args as an array:

```jsonc
{ "mcpServers": { "my": { "command": "npx", "args": ["-y", "@pkg/server"] } } }
```

### `LD_PRELOAD` / `NODE_OPTIONS` ignored

These keys (and `DYLD_*`, `PYTHONPATH`, …) are stripped from a server's `env`
because they enable code injection. Pass only safe config values.

### Server process hangs after close

`close()` sends `SIGTERM` then escalates to `SIGKILL` after 1.5s. If a process
still lingers, it's ignoring both signals (uncommon). Confirm with
`azycode mcp status` and restart the TUI if needed.

---

## Missions & subagents

### `Subagent nesting depth limit (2) reached`

Subagent recursion is capped by `maxSubagentDepth` (default 2). Raise it if you
genuinely need deeper fan-out, but prefer flattening the mission:

```bash
azycode config set maxSubagentDepth 3
```

### `Subagent alwaysApprove` behavior changed

Subagents now inherit the parent's permission profile instead of forcing
`alwaysApprove: true`. If a subagent that used to auto-write now asks for
approval, set the parent profile to `trusted-workspace` or `full-auto`.

### `Unknown subagent: <name>`

The subagent isn't registered. List and add:

```bash
azycode subagent list
azycode subagent add implementer --description "writes code" --system "..."
```

### Subagent worktree cleanup left files

Best-effort cleanup can fail on locked files. Remove manually:

```bash
git worktree prune
rm -rf .azycode/worktrees/
```

---

## TUI & rendering

### No colors / garbled output

Azycode auto-detects color support. Override if needed:

```bash
export FORCE_COLOR=1     # force color (even when piped)
export NO_COLOR=1        # disable color
```

`TERM=dumb` disables color. The UI degrades to plain text automatically.

### Screen scrolls oddly / composer overlaps output

Resize the terminal, or press `Ctrl+L` to clear and redraw. Margins and pane
sizing adapt to `stdout.columns`. Non-TTY (piped) output skips the composer.

### `/clear` doesn't reset the conversation

`/clear` only redraws the screen. Use `/new` to start a fresh conversation, or
`/compact` to trim context while keeping recent history.

---

## Testing & development

### `npm test` fails with a single `test failed` and a module error

A stray `.js` file at the repo root can be auto-discovered. Make sure you're
using `npm test` (scoped to `test/**/*.test.js`), not bare `node --test`.

### A specific test file hangs in isolation

Check for an unmocked network call or an unbounded `setInterval` in a fixture.
The agent/subagent tests spin up a local HTTP mock server; ensure the port is
freed in the `finally` block.

### `npm run check` reports a syntax error after edits

```bash
npm run check   # node --check bin/azycode.js && node --check src/*.js
```

It only parses — fix the reported file/line. Note it globs `src/*.js` (top
level); run `node --check src/ui/*.js src/tui/*.js` to also check sub-modules.

### Coverage / "test only" runs

Azycode uses Node's built-in runner (`node --test`). There is no coverage
reporter wired in; use `c8 node --test "test/**/*.test.js"` if you need
coverage numbers.

---

## Diagnostics cheatsheet

```bash
azycode status --json      # provider, model, guard, mode
azycode health --json      # provider connectivity + model list
azycode doctor --json      # local binaries, config paths, env
azycode audit              # config + state summary
azycode report             # recent sessions and tool activity
azycode guard status --json
azycode bench run --mock   # internal benchmark without a provider
```

For the full public API surface, see [API.md](./API.md).
