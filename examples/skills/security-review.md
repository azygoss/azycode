---
description: "Lead security review with the highest-impact risks: injection, auth, secrets, SSRF."
activation: ["security", "vulnerability", "cve", "audit", "owasp"]
tags: ["security", "review"]
---

# Security Review

When reviewing a change for security, prioritize by exploitability and impact:

1. **Injection** — SQL/NoSQL/command/template injection. Trace user input to
   every sink (query builders, shells, eval, template engines).
2. **Authentication & authorization** — missing checks, IDOR, privilege
   escalation, token handling, session fixation.
3. **Secrets** — hardcoded keys, secrets in logs/urls/error messages, weak
   random for tokens.
4. **SSRF & path traversal** — outbound fetches of user-supplied URLs,
   filesystem access of user-supplied paths, symlink escape.
5. **Deserialization & config** — untrusted JSON/YAML/pickle, dangerous
   container mounts, disabled guards.

For each finding, state the attack scenario, the severity, and a concrete fix.
Do not approve a change that weakens a guard or broadens a permission surface
without an explicit, justified override.
