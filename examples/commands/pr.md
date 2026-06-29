---
name: pr
description: "Prepare a pull-request summary from the current diff."
scope: project
args: false
---

Summarize the current branch's changes for a pull request.

1. Run `git diff <base>...HEAD` to gather the full diff (use the default branch
   as the base if unsure).
2. Group the changes into logical themes (feature, fix, refactor, test, docs).
3. Write a PR description with:
   - **Summary** — one paragraph of what and why.
   - **Changes** — bulleted themes with the key files/areas touched.
   - **Verification** — the commands run to validate (tests, checks, manual
     steps) and their results.
4. Propose a Conventional Commits-style title under 72 characters.
5. Note any follow-up work, risks, or breaking changes explicitly.

Do not invent changes that are not in the diff. If the diff is empty, say so.
