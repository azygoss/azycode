# Azycode Completion Audit

Generated for the first product-quality pass of `azycode`.

## Requirement Coverage

| Requirement | Status | Evidence |
| --- | --- | --- |
| Standalone CLI named `azycode` | Implemented | `package.json` bin points to `bin/azycode.js`; `azycode doctor` verifies PATH realpath. |
| Work in this repository, not old `azy-code` | Implemented | Runtime is under this repo's `src/` and does not shell out to another harness. |
| Provider login without hardcoded keys | Implemented | `azycode login <provider>` writes user keys to config; `config export` and `report` redact them. |
| BYOK | Implemented | `login byok --base-url ... --model ... --api-key ...`. |
| OpenAI-compatible provider presets | Implemented | OpenAI, Kimi, Z.AI Coding Plan, MiniMax, OpenCode Go, BYOK presets. |
| Plan, review, always-approve, goal modes | Implemented | Direct commands plus `config set mode`; shortcut rotation in interactive prompt. |
| Reasoning level control | Implemented | `config set reasoning` and interactive Tab rotation. |
| Model tool calls | Implemented | Agent loop exposes filesystem, search, patch, shell, and git diff tools. |
| Subagents and custom subagents | Implemented | Built-ins plus `subagent add/list/remove/run`. |
| Missions | Implemented | JSON and small YAML missions with dry-run, reports, object steps, dependencies, and continue-on-error. |
| Status and quota visibility | Partially provider-limited | `status` and `health` call model-list endpoints; exact subscription quota depends on provider support. |
| Approval/safety controls | Implemented | Tool policies, permission profiles, always-approve, and independent git guard. |
| Review mode | Implemented | Model-backed review plus `review --local` heuristic git review. |
| Diagnostics | Implemented | `doctor`, `doctor --json`, `audit`, `report`, `tools log`, sessions/transcripts. |
| Shell installation usability | Implemented | `npm link`/global bin support and `completion <bash|zsh|fish>`. |

## Verification Commands

Run these from `/Users/berkcankuyumcu/Documents/GitHub/azycode`:

```sh
npm test
npm run check
azycode audit
azycode doctor --json
azycode completion zsh
azycode report
```

## Improvements Since Initial Audit

| Improvement | Evidence |
| --- | --- |
| LLM fetch timeout + retry with exponential backoff | `src/llm.js`: `fetchWithTimeout` and `fetchWithRetry`; env `AZYCODE_REQUEST_TIMEOUT_MS` |
| Config/state/todos in-memory caching with mtime invalidation | `src/config.js`: `_configCache`, `_stateCache`, `_todosCache` |
| Config validation normalizes invalid values to safe defaults | `src/config.js`: `validateConfig` |
| Centralized logger with levels and env control | `src/logger.js`: `debug/info/warn/error`; env `AZYCODE_LOG_LEVEL` and `AZYCODE_DEBUG` |
| CLI `--version` / `-v` flag | `src/cli.js`: `--version` handler |
| Expanded local-review security heuristics | `src/local-review.js`: eval, innerHTML, child_process.exec, TODO/FIXME detection |
| Tighter git branch name validation | `src/guard.js`: `validateBranchName` rejects refspec characters |
| Agent runtime logging for errors and step limits | `src/agent.js`: logger integration in tool failures and step-limit paths |
| Input validation on tools (positive bounds for numeric params) | `src/tools.js`: `Math.max(1, ...)` on `maxBytes`, `timeoutMs`, `depth` |
| Input validation on skills/subagents (length limits) | `src/skills.js` and `src/subagents.js`: 64-char name, 200-char description, 10000-char text/system limits |
| Mission YAML parser line-numbered errors | `src/missions.js`: `parseTinyYaml` throws with line numbers |
| Async context pack to reduce blocking IO | `src/context.js`: `fs.promises.readFile` in `contextPack` |
| Hardened error boundaries in CLI entrypoint | `bin/azycode.js`: `uncaughtException` and `unhandledRejection` handlers |
| Package metadata enriched | `package.json`: keywords, repository, bugs, homepage |
| Memory caching with mtime invalidation | `src/memory.js`: `_memoryCache` and `_memoryMtime` |
| Grep fallback for search when ripgrep is missing | `src/tools.js`: `grep -rn` fallback when `rg` is not found |
| Conversation limit configurable via config | `src/tui.js`: `maxConversationMessages` read from config |
| Cleaner event formatting (omits empty sessionId) | `src/harness.js`: event formatting omits empty brackets |
| Provider diagnostics include model list and note | `src/providers.js`: `providerDiagnostics` returns `models` and `note` |
| README usage examples section | `README.md`: practical examples for goals, missions, review, context |
| Live-filtered command palette in TUI | `src/tui.js`: `handleKeypress` updates palette on every keystroke with `printFilteredCommandPalette` |
| Interactive skill picker with arrow keys | `src/tui.js`: `/skill add` and `/skill remove` use `selectFromList` for arrow-key navigation |
| Screen clear shortcut (Ctrl+L) in TUI | `src/tui.js`: `handleKeypress` handles `Ctrl+L` to clear screen |

## Known Provider Limits

ChatGPT web subscriptions are not API credentials. Azycode can use API keys or OpenAI-compatible subscription endpoints when the provider exposes them. Remaining quota is not standardized across OpenAI-compatible APIs, so `status` reports live connectivity and documented quota notes where available, while exact remaining limits may still require the provider dashboard.
