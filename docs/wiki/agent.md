# Your agent

While an instance is open, Modbench serves an MCP server at `http://127.0.0.1:47200/mcp`. Set `modbench.agent.port` to use another port. Two windows open at once need a port each, so set it per workspace.

VS Code Chat finds the server with no setup.

For Claude Code, run this once in the instance folder, with the instance's port. Claude Code reads it in each conversation you start after that.

```bash
claude mcp add --transport http modbench http://127.0.0.1:47200/mcp
```

The server tells the agent the rest: how to name objects, which job is a file edit, a gesture or a script.
