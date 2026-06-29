---
description: "Produce minimal, focused git commits. Group related changes; split unrelated ones."
activation: ["commit", "pr", "pull request", "changelog", "history"]
tags: ["vcs", "workflow"]
---

# Conventional Commits

Write commit messages in the Conventional Commits format so history stays
readable and changelogs can be generated automatically:

```
<type>(<scope>): <imperative summary>

<body explaining why, not what>
```

Use lowercase types: `feat`, `fix`, `refactor`, `test`, `docs`, `perf`,
`chore`, `ci`. Keep the summary under 72 characters. The body should explain
the motivation and any non-obvious trade-offs.

Staged changes should form a single logical unit. If a commit touches
unrelated concerns, split it. Never commit secrets, build artifacts, or
lockfile churn unless it is the focus of the change.
