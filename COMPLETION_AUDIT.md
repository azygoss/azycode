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

## Known Provider Limits

ChatGPT web subscriptions are not API credentials. Azycode can use API keys or OpenAI-compatible subscription endpoints when the provider exposes them. Remaining quota is not standardized across OpenAI-compatible APIs, so `status` reports live connectivity and documented quota notes where available, while exact remaining limits may still require the provider dashboard.
