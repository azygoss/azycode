---
name: explain
description: "Explain how a module, function, or feature works with references."
scope: project
args: true
---

Explain {{args}}.

Provide a focused explanation that includes:

- **Purpose** — what the code does and why it exists.
- **How it works** — the key control flow and data structures, in order.
- **Inputs and outputs** — the public API, parameters, and return shapes.
- **Side effects** — filesystem writes, network calls, state mutations.
- **References** — cite `file_path:line` anchors so the reader can jump to the
  code. Prefer the actual implementation over paraphrase.

Keep it concise. If the topic spans many files, lead with a one-paragraph
summary, then the detail. Do not speculate about behavior you have not read.
