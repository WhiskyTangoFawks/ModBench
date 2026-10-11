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
SLOT_RUN = (pathlib.Path(__file__).resolve().parents[1] / "skills/validate/slot-run.sh").as_posix()
BUILD = "|".join((r"\bdotnet\s+(?:build|test|format|publish)(?![\w-])",
                  r"\bnpm\s+(?:run\s+)?(?:test|build|package)\b",
                  r"\bnpx\s+vitest\b"))
DOTNET_RUN = r"\bdotnet\s+run\b"
HEREDOC = re.compile(r"(?<!<)<<-?\s*(['\"]?)(\w+)\1([^\n]*)\n.*?^\s*\2\s*$", re.DOTALL | re.MULTILINE)
RUN = r"(?:(?:^|[;&|(\n])\s*|(?<![\w.])(?:ba)?sh\s+(?:-\S+\s+)*)"
GATE = BUILD + "|" + RUN + r"\S*run-gates\.sh\b(?!.*--detach)|\bdetached\.sh\s+wait\b"


def block(message):
    print(f"Blocked: {message}", file=sys.stderr)
    sys.exit(2)


def outside_the_slot(segment):
    build = re.search(BUILD, segment)
    return build and "slot-run.sh" not in segment[:build.start()]


def builds_or_holds_the_slot(segment):
    run = re.search(DOTNET_RUN, segment)
    return run and ("--no-build" not in segment[run.end():] or "slot-run.sh" in segment[:run.start()])


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
# Heredoc bodies and quoted content are data (issue bodies, commit messages, a command for the
# Windows VM), not a command this machine runs.
bare = re.sub(r"\"[^\"]*\"|'[^']*'", "", HEREDOC.sub(r"\3", command))
segments = re.split(r"[;&|\n]", bare)
if any(builds_or_holds_the_slot(segment) for segment in segments):
    block(
        "a process `dotnet run` starts can live for hours, so it neither builds nor runs in the "
        f"build slot. Build with `bash {SLOT_RUN} dotnet build <project>`, then start it with "
        "`dotnet run --no-build --project <project>`, outside slot-run.sh."
    )
if any(outside_the_slot(segment) for segment in segments):
    block(
        "builds and tests run one at a time machine-wide, because parallel runs beside VS Code "
        f"exhaust the machine's memory. Prefix the build: `bash {SLOT_RUN} "
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
