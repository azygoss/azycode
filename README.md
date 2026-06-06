# azycode ⚡

**The lean, dependency-free AI coding harness for your terminal.**

Tired of bloated AI agents that take minutes to initialize and come with a massive dependency tree? Meet **azycode** — a lightweight, lightning-fast AI coding CLI built in pure JavaScript with **zero external dependencies**. It gives you full agentic power (missions, subagents, and tool calls) while staying out of your way.

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
- **Agentic Missions:** Define multi-step complex workflows in simple YAML/JSON files.
- **Interactive TUI:** A sleek terminal interface with command palettes (`/`) and live progress.
- **Flexible Modes:** 
  - `plan`: Research and propose changes without touching code.
  - `goal`: Autonomous execution with tool-call capability.
  - `always-approve`: Speed through tasks (at your own risk!).
- **BYOK (Bring Your Own Key):** Supports any OpenAI-compatible endpoint (local LLMs, Kimi, MiniMax, etc.).
- **Security First:** Built-in Git Guard protects your `main`/`master` branches from accidental overwrites.

---

### 🛠️ Real-World Usage

**1. Autonomous Goal Execution**
Let the agent research, implement, and test a feature.
```bash
azycode goal start "refactor src/ui.js to use the new logger"
```

**2. Local Code Review**
Get instant AI security heuristics and logic checks on your uncommitted changes.
```bash
azycode review --local
```

**3. Running Automation Missions**
Run repeatable developer workflows defined in `mission.yml`.
```bash
azycode mission run examples/standard-cleanup.yml
```

---

### 🏗️ Architecture Overview

Azycode is a dependency-free Node.js core that manages agent loops, LLM routing, and tool execution. It features a custom TUI engine built on native terminal primitives and uses a secure, file-based configuration system. Designed for portability, it isolates environments via the `AZYCODE_HOME` variable, making it perfect for CI/CD and local development.

---

### 🤝 Contributing & Support

We love lightweight contributions! If you find a bug or have a feature idea, feel free to open an issue or submit a PR. 

- **Check code:** `npm run check`
- **Run tests:** `npm test`
- **Report bugs:** [GitHub Issues](https://github.com/azygoss/azycode/issues)

---

### 📄 License

Distributed under the **MIT License**.

---

**Built with ❤️ by Interaction Company of California.**
*Make coding effortless. Keep it lightweight.*
