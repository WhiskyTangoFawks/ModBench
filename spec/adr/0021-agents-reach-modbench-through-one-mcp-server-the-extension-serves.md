# Agents reach Modbench through one MCP server the extension serves

The user's agent runs in VS Code, in Chat or in its own panel, and MCP is the one door to tools that every such agent reads. So the extension serves one MCP server, and each agent reaches it by its standard MCP setup. The extension holds the reach of both columns, because mod management lives in it (ADR-0016) and mEdit is one client call away ([principles](../principles.md): Existing tools; Orthogonality).

## Consequences

- A record in plugin source has no edit gesture for the agent. The format is Modbench's own, so the agent edits the files, and git and the Problems panel review the edit as they review a hand edit (ADR-0007).
- The mod manager's files have no file route for the agent. The gestures are its one way to change them, so the agent acts the same in every mod manager's instance.
- A change to many records by a rule is a script. The user's agent writes and runs one as the user does, and the script, not the agent, is mEdit's client ([scripts.md](../surfaces/scripts.md)).

## Alternatives rejected

- VS Code language model tools. Claude Code does not see them.
- An MCP server in mEdit. Mod management and the file order conflicts live in the extension, so the server would reach records only, or mEdit would call back into the extension.
- mEdit's HTTP API, given to a terminal agent. It reaches records only.
- A staged review of the agent's changes. ADR-0007 rejects a staged model. Git and the trash serve the agent as they serve the user.
