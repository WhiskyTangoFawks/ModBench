---
status: accepted
---

# Agent integration uses VS Code Language Model API, not a standalone MCP server

Agent-driven editing uses VS Code's built-in chat and Language Model API. The extension registers
tools that a VS Code agent can call; those tools invoke `SessionController` methods, which hit the
C# backend. Agent edits land as working-tree changes in the tracked mod's source exactly like
manual edits — the user reviews them in the native Source Control diff, commits or discards, and
Save & Compile is still the explicit gesture that writes the binary ([ADR-0041](0041-manual-git-tracking-compile-from-text.md)).

The key reason to prefer this over MCP: the agent capability is wanted *inside VS Code*, where
the user is already working. A separate MCP server would duplicate the integration surface the
extension already provides, and require running and maintaining a third process.

`SessionController` must remain free of VS Code types so its methods can be called directly from
chat tool handlers without pulling in the extension host.

## Alternatives rejected

- **Standalone MCP server** — exposes the C# backend as an MCP tool surface any agent can call.
  More portable, but a third process to build and run, duplicating the command surface the
  extension owns. Deferred — revisit if the tool needs to be driven by agents outside VS Code.
- **Direct HTTP from the agent** — scripts already are HTTP clients (ADR-0024), so nothing
  prevents it; what it loses is the in-editor loop (tool results and the resulting diff surfacing
  where the user is working). Not the primary path.
