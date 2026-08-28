---
status: accepted
---

# Timestamped binary backups before every plugin write

Before any write to a plugin binary, the target is copied to a timestamped backup
(`MyMod.esp.2024-01-15T14-32-00.bak`). The last N backups are kept; older ones are pruned. This is
the same pattern xEdit uses.

For a tracked mod, history and revert are git's (ADR-0041); the `.bak` is a belt-and-braces guard
against a compile bug and is retained until compile-from-source has soaked.

## Alternatives rejected

- **Event sourcing / operation log** — correct but overengineered. The `.bak` pattern is
  sufficient for the binary; git covers the source.
