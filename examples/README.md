# Azycode Examples

Copy-paste-ready starting points for skills, commands, missions, and subagents.
Each example is self-contained and documented so you can adapt it to your
project. Project-scoped files (skills, commands) live under `.azycode/`; global
skills/subagents are stored in your config under `~/.azycode/`.

## Layout

```
examples/
├── skills/          # Project skills (.azycode/skills/<name>.md)
│   ├── tdd.md
│   ├── conventional-commits.md
│   └── security-review.md
├── commands/        # Project slash commands (.azycode/commands/<name>.md)
│   ├── fix.md
│   ├── explain.md
│   └── pr.md
├── missions/        # Mission files (JSON or YAML)
│   ├── feature-with-tests.json
│   └── parallel-review.yml
└── subagents/       # Subagent profiles (import via `subagent add`)
    ├── implementer.json
    └── explorer.json
```

## Skills

Project skills are markdown files with optional YAML frontmatter. Drop them in
`.azycode/skills/` and they activate automatically (by keyword) or when named
explicitly:

```bash
mkdir -p .azycode/skills
cp examples/skills/tdd.md .azycode/skills/tdd.md
azycode skills list
```

Frontmatter fields: `description`, `activation` (keywords that auto-activate the
skill), `tags`.

## Commands

Markdown slash commands with `{{args}}` expansion. Frontmatter: `name`,
`description`, `scope`, `args`. Place in `.azycode/commands/`:

```bash
mkdir -p .azycode/commands
cp examples/commands/fix.md .azycode/commands/fix.md
# Then in the TUI: /fix "the flaky test in test/logger.test.js"
```

## Missions

Multi-step workflows in JSON or a small YAML subset, with dependency ordering
and parallel groups. Run with:

```bash
azycode mission dry-run examples/missions/parallel-review.yml --json
azycode mission run examples/missions/feature-with-tests.json --progress
```

## Subagents

Subagent profiles define specialized agents with their own system prompt,
reasoning level, and optional model. Register one from a JSON file:

```bash
# The JSON shape matches what `subagent add` expects:
azycode subagent add implementer \
  --description "Writes focused code changes with tests" \
  --system "$(cat examples/subagents/implementer.json | jq -r .system)"
azycode subagent list
```
