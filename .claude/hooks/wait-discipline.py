#!/usr/bin/env python3
"""PreToolUse[Bash|Monitor]: a build or test runs in the build slot, a gate or wait command
carries an explicit timeout, and a subagent waits in the foreground.

The Bash tool's 120 s default silently backgrounds a longer run, so a gate invoked
without a timeout can report nothing while still running. A subagent's turn ending is
its report, so a background command or a monitor it means to wait on never reaches it."""
import json
import pathlib
import re
import sys

from hook_caller import is_subagent

DETACHED = "bash .claude/skills/validate/detached.sh"
SLOT_RUN = pathlib.Path(__file__).resolve().parents[1] / "skills/validate/slot-run.sh"
BUILD = "|".join((r"\bdotnet\s+(?:build|test|format|publish)(?![\w-])",
                  r"\bnpm\s+(?:run\s+)?(?:test|build|package)\b",
                  r"\bnpx\s+vitest\b"))
BUILDING_RUN = r"\bdotnet\s+run\b(?!.*--no-build)"
RUN = r"(?:(?:^|[;&|(\n])\s*|(?<![\w.])(?:ba)?sh\s+(?:-\S+\s+)*)"
GATE = BUILD + "|" + RUN + r"\S*run-gates\.sh\b(?!.*--detach)|\bdetached\.sh\s+wait\b"


def block(message):
    print(f"Blocked: {message}", file=sys.stderr)
    sys.exit(2)


def outside_the_slot(segment):
    build = re.search(BUILD, segment)
    return build and "slot-run.sh" not in segment[:build.start()]

data = json.load(sys.stdin)
tool = data.get("tool_name")
tool_input = data.get("tool_input", {})
subagent = is_subagent(data)

if subagent and (tool == "Monitor" or tool_input.get("run_in_background")):
    block(
        "a subagent's turn ending is its report, so nothing it waits for in the "
        "background ever reaches it. Run the command in the foreground with a timeout, or "
        f"start it with `{DETACHED} start <name> <command...>` and poll it with "
        f"`{DETACHED} wait <name>` in the foreground until it prints the verdict."
    )
command = tool_input.get("command", "")
# Quoted content is data (issue bodies, commit messages, a command for the Windows VM), not a
# command this machine runs.
bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", command)
segments = re.split(r"[;&|\n]", bare)
if any(re.search(BUILDING_RUN, segment) for segment in segments):
    block(
        "`dotnet run` builds first, and a process it starts would hold the build slot for its "
        f"whole life. Build with `bash {SLOT_RUN} dotnet build <project>`, then start it with "
        "`dotnet run --no-build --project <project>`."
    )
if any(outside_the_slot(segment) for segment in segments):
    block(
        "builds and tests run one at a time machine-wide, under a memory cap, because parallel "
        f"runs beside VS Code exhaust the machine's memory. Prefix the build: `bash {SLOT_RUN} "
        f"<command...>`, as in `cd MEditService && bash {SLOT_RUN} dotnet test --filter X`. It "
        "waits for the slot, so give it the Bash timeout 600000."
    )
if tool != "Bash" or tool_input.get("run_in_background"):
    sys.exit(0)
timeout = tool_input.get("timeout") or 0
if re.search(GATE, bare) and timeout < 600000:
    block(
        "this command runs or waits on a gate and needs the Bash timeout "
        "parameter set to 600000 — the 120 s default silently backgrounds longer runs, "
        "and a gate wait blocks for up to 540 s. Re-issue the same command with it set."
    )
