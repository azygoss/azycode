---
name: fix
description: "Diagnose and fix a failing test or error, then verify the fix."
scope: project
args: true
---

Investigate and fix the issue described in {{args}}.

Follow a systematic debugging approach:

1. **Reproduce** — Confirm the failure with the exact command. Capture the full
   error output and stack trace.
2. **Localize** — Find the smallest change that triggers the failure. Use search
   and read tools to narrow the cause; avoid broad speculative edits.
3. **Hypothesize** — Form one hypothesis. Add the minimal code change that would
   resolve it under that hypothesis.
4. **Verify** — Re-run the reproduction command. If it still fails, revert and
   try the next hypothesis. Do not pile changes on top of an unverified fix.
5. **Check for regressions** — Run the relevant test file or suite to ensure the
   fix did not break adjacent behavior.

Report: the root cause, the fix applied, and the verification command used.
