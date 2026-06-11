# azycode ⚡

**The lean, dependency-free AI coding harness for your terminal.**

Tired of bloated AI agents that take minutes to initialize and come with a massive dependency tree? Meet **azycode** — a lightweight, lightning-fast AI coding CLI built in pure JavaScript with **zero external dependencies**. It gives you full agentic power (missions, subagents, MCP, skills, and tool calls) while staying out of your way.

---

### ⚡ 30-Second Quick Start

```bash
# 1. Install (requires Node 20+)
npm install -g .

# 2. Login to your favorite provider
azycode login kimi   # or openai, minimax, byok, etc.

# 3. Start a goal
azycode goal start "Add a unit test for src/logger.js"
```

---

### 🎨 The Interactive TUI Workspace

Run `azycode` without arguments to enter the **Interactive Workspace**. It’s a full-featured terminal UI for real-time collaboration with your LLM.

```text
┌──────────────────────────────────────────────────────────┐
│  azycode » [plan] [high]                                 │
├──────────────────────────────────────────────────────────┤
│  /status      - Check provider & session health          │
│  /context     - Pack & preview repository context        │
│  /mission     - Run or report on automation missions     │
│  Tab          - Cycle Reasoning (minimal → high)         │
│  Shift+Tab    - Cycle Mode (plan → goal → approve)       │
│                                                          │
│  > Add a security-reviewer subagent to check this diff   │
└──────────────────────────────────────────────────────────┘
```

---

### 🔥 Key Highlights

- **Zero Dependencies:** Built entirely with Node.js built-ins. No `node_modules` bloat.
- **Agentic Missions:** Multi-step workflows in JSON or a small YAML subset, with dependency ordering, parallel groups, and schema validation.
- **Subagents:** Built-in planner, reviewer, implementer, and explorer profiles; optional git worktree isolation for parallel runs.
- **MCP Integration:** Stdio MCP servers with probe/inspect, tool policy, resources, and prompts.
- **Skills & Commands:** Global and project-scoped skill prompts; markdown slash commands with `{{args}}` expansion.
- **Security Layer:** Git guard, path guard, shell risk classification, local review heuristics, and `review --security`.
- **Context Packs:** Layered retrieval with byte budgets, injection hardening, and cache invalidation.
- **Flexible Modes:** `plan`, `build`, `goal`, `review`, and `always-approve`.
- **BYOK:** Any OpenAI-compatible endpoint (local LLMs, Kimi, MiniMax, OpenCode Go, etc.).

---

### 🛠️ Real-World Usage

**1. Autonomous goal execution**

```bash
azycode goal start "refactor src/ui.js to use the new logger"
azycode run --context --progress "fix the failing test in src/logger.js"
```

**2. Local and security review**

```bash
azycode review --local              # fast heuristic scan, no provider
azycode review --local --json
azycode review --security           # heuristics + test hints + model review when configured
```

**3. Mission automation**

```bash
azycode mission dry-run ./mission.yml --json   # DAG, risk, permissions preview
azycode mission run ./mission.yml --progress
azycode mission report <id>
```

**4. Subagents**

```bash
azycode subagent list
azycode subagent run reviewer "review the current diff"
azycode subagent spawn --json '[{"agent":"explorer","prompt":"map src/"}]'
# Optional isolation: config set subagentIsolation worktree
```

**5. Skills and custom commands**

```bash
azycode skills list --json
azycode skills add my-skill --description "Testing" --text "Always write tests."
azycode skills export my-skill --to ./my-skill.json
# Project skills live in .azycode/skills/<name>.md with optional activation rules

azycode commands list
azycode commands preview fix "src/cli.js"
# Commands live in ~/.azycode/commands/ and .azycode/commands/
```

**6. MCP servers**

```bash
azycode mcp list
azycode mcp status --json
azycode mcp inspect my-server
azycode mcp resources my-server
```

**7. Patch validation (isolated worktree)**

```bash
azycode patch validate changes.diff
azycode patch validate changes.diff --check "npm test" --json
```

**8. Context, guard, and diagnostics**

```bash
azycode context pack --json
azycode guard status --json
azycode status --json
azycode health --json
azycode doctor --json
azycode bench run --mock
```

---

### ⚙️ Configuration

Config and state live in `~/.azycode` (override with `AZYCODE_HOME`). Files are written with `0600` permissions.

```bash
azycode config set mode build
azycode config set profile read-only          # normal | read-only | plan-only | safe-write | trusted-workspace | full-auto
azycode config set guard enabled true         # blocks writes on main/master by default
azycode config set sandbox.mode local         # local | docker | podman | none
azycode config set subagentIsolation worktree # same-workspace | worktree
```

MCP servers are configured under `mcpServers` in `config.json`. See `azycode help mcp` after install.

Project conventions:

| Path | Purpose |
| --- | --- |
| `AGENTS.md` / `.azycode/rules.md` | Trusted project instructions |
| `.azycode/commands/*.md` | Project slash commands |
| `.azycode/skills/*.md` | Project-scoped skills |
| `.azycode/missions/*` | Mission files |

---

### 🏗️ Architecture Overview

Azycode is designed for speed and portability.

- **Core:** Agent loop, LLM routing, tool execution, compaction, and session state.
- **Providers:** OpenAI Chat Completions, Anthropic Messages normalization, capability registry, and diagnostics.
- **Safety:** Permission profiles, path guard, git guard, shell risk classifier, execution policy, optional sandbox backends.
- **Extensibility:** MCP stdio clients, skills, custom commands, hooks.
- **Review:** Local heuristics (`local-review.js`), security review (`security-review.js`), patch validation in worktrees (`patch-validation.js`).

See [ARCHITECTURE.md](ARCHITECTURE.md) for module-level detail.

---

### 📚 Help Topics

```bash
azycode help                  # command overview
azycode help mission
azycode help review
azycode help permissions
azycode help sandbox
azycode help context
azycode help bench
```

---

### 🤝 Contributing & Support

- **Check code:** `npm run check`
- **Run tests:** `npm test` (405 tests)
- **Report bugs:** [GitHub Issues](https://github.com/azygoss/azycode/issues)

---

### 📄 License

Distributed under the **MIT License**. See `LICENSE` for more information.

---

**Make coding effortless. Keep it lightweight.**