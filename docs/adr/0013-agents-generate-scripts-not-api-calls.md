---
status: accepted
---

# Prefer scripts over direct API calls for complex agent tasks

For multi-record or complex automated edits, the preferred agent output is a script (SQL
selection + Python body, [ADR-0024](0024-python-scripts-are-http-clients.md)) rather than a
sequence of field writes. Scripts are readable, rerunnable, and deterministic — the user gets two
review gates: the script itself, then the working-tree diff it produces in the native Source
Control panel.

Agents may still call the API directly for simple, single-record operations where generating a
script would be heavier than the task warrants. The distinction is: use scripts when the agent's
intent is hard to verify from a list of field diffs alone.

## Consequences

The scripting engine is a meaningful prerequisite for the agentic workflow — not just a power-user
feature — because it provides the inspection surface for complex agent tasks.
