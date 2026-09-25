#!/usr/bin/env python3
"""PreToolUse[Bash|Monitor]: a gate or wait command carries an explicit timeout, and a
subagent waits in the foreground.

The Bash tool's 120 s default silently backgrounds a longer run, so a gate invoked
without a timeout can report nothing while still running. A subagent's turn ending is
its report, so a background command or a monitor it means to wait on never reaches it."""
import json
import re
import sys

from hook_caller import is_subagent

DETACHED = "bash .claude/skills/validate/detached.sh"
GATE = r"\bdotnet\s+(test|build)\b|\bnpm\s+run\s+(test|build)|\brun-gates\.sh\b(?!.*--detach)|\bdetached\.sh\s+wait\b"

data = json.load(sys.stdin)
tool = data.get("tool_name")
tool_input = data.get("tool_input", {})
subagent = is_subagent(data)

if subagent and (tool == "Monitor" or tool_input.get("run_in_background")):
    print(
        "Blocked: a subagent's turn ending is its report, so nothing it waits for in the "
        "background ever reaches it. Run the command in the foreground with a timeout, or "
        f"start it with `{DETACHED} start <name> <command...>` and poll it with "
        f"`{DETACHED} wait <name>` in the foreground until it prints the verdict.",
        file=sys.stderr,
    )
    sys.exit(2)
if tool != "Bash" or tool_input.get("run_in_background"):
    sys.exit(0)
command = tool_input.get("command", "")
timeout = tool_input.get("timeout") or 0
# Quoted content is data (issue bodies, commit messages), not a command to run.
bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", command)
if re.search(GATE, bare) and timeout < 600000:
    print(
        "Blocked: this command runs or waits on a gate and needs the Bash timeout "
        "parameter set to 600000 — the 120 s default silently backgrounds longer runs, "
        "and a gate wait blocks for up to 540 s. Re-issue the same command with it set.",
        file=sys.stderr,
    )
    sys.exit(2)
