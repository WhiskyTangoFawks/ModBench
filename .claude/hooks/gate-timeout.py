#!/usr/bin/env python3
"""PreToolUse[Bash]: test/build commands must carry an explicit timeout.

The Bash tool's 120 s default silently backgrounds a longer run, so a gate
invoked without a timeout can report nothing while still running. Backgrounded
calls are exempt: they are explicitly asynchronous."""
import json
import re
import sys

data = json.load(sys.stdin)
tool_input = data.get("tool_input", {})
if tool_input.get("run_in_background"):
    sys.exit(0)
command = tool_input.get("command", "")
timeout = tool_input.get("timeout") or 0
if re.search(r"\bdotnet\s+(test|build)\b|\bnpm\s+run\s+(test|build)", command) and timeout < 300000:
    print(
        "Blocked: this command runs a test/build gate and needs an explicit Bash "
        "timeout >= 300000 ms — the 120 s default silently backgrounds longer runs. "
        "Re-issue the same command with the timeout parameter set (e.g. 600000).",
        file=sys.stderr,
    )
    sys.exit(2)
