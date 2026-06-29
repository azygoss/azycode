---
description: "Write tests before implementation. Verify behavior, not implementation details."
activation: ["test", "spec", "tdd", "red-green", "failing test"]
tags: ["testing", "discipline"]
---

# Test-Driven Development

When asked to add or change behavior, follow the red-green-refactor loop:

1. **Red** — Write a failing test that describes the desired behavior. Run it and
   confirm it fails for the right reason (not a syntax error or missing import).
2. **Green** — Write the minimum code to make the test pass. Do not add behavior
   the test does not yet require.
3. **Refactor** — Improve the code without changing behavior; re-run the test.

Prefer the project's existing test runner and conventions. Assert on observable
behavior and public APIs, not private internals. If a change is hard to test,
that is a signal to improve the design first.
