#!/usr/bin/env python3
"""PreToolUse[Edit|Write|NotebookEdit|Bash]: a subagent never writes a protected spec file, nor the
settings and hooks that guard them, in any checkout or worktree. The main session's file edits are left
to the `ask` rules in settings.json; its shell writes to a protected file, which those rules miss, are
put to the maintainer.

A shell command is read by its literal words, so a path it builds at runtime is not seen."""
import json
import os
import re
import shlex
import sys

from hook_caller import is_subagent

SPEC = re.compile(r"(?:^|/)(?:docs/(?:adr|architecture)(?:/|$)|(?:CONTEXT|CLAUDE)\.md$)")
GUARD = re.compile(r"(?:^|/)\.claude/(?:settings[^/]*\.json$|hooks(?:/|$))")
MENTION = re.compile(r"(?<![\w-])(?:docs/(?:adr|architecture)(?:/[\w.-]+)*|(?:CONTEXT|CLAUDE)\.md"
                     r"|\.claude/(?:settings[\w.-]*\.json|hooks(?:/[\w.-]+)*))(?![\w-]|\.\w)")
HEREDOC = re.compile(r"(<<-?\s*(['\"]?)(\w+)\2[^\n]*\n)(.*?)^\s*\3\s*$", re.S | re.M)
SCRIPT_WRITE = re.compile(r"open\([^)]*['\"][wax+][bt+]?['\"]|open\([^)]*['\"]\s*>|\.write_(?:text|bytes)\("
                          r"|shutil\.(?:copy\w*|move)\(|os\.(?:remove|unlink|rename|replace)\(|\.unlink\("
                          r"|\bunlink\b|\brename\b")
COMMENT = re.compile(r"""('[^']*'|"(?:\\.|[^"\\])*")|(?:(?<=\s)|^)#[^\n]*""", re.M)
COPY_SOURCE = re.compile(r"(shutil\.copy\w*\()[^,]*,")
PREFIXES = {"sudo", "env", "command", "time", "nohup", "exec"}
OPERAND_WRITERS = {"mv", "rm", "rmdir", "unlink", "truncate", "shred", "tee"}
GIT_PATH_WRITERS = {"checkout", "restore", "rm", "mv"}
OPERATOR = set(";&|()\n")
REPORT = "Put the exact before/after text in your report for the maintainer's approval."
SPEC_FLOW = ("docs/architecture, the ADRs, CONTEXT.md and every CLAUDE.md are the maintainer's source of "
             f"truth, and you build from them. Never edit them. {REPORT}")
GUARD_FLOW = ("The Claude Code settings and hooks guard the maintainer's source of truth and are the "
              f"maintainer's to change. Never edit them. {REPORT}")


def protected(path):
    return bool(SPEC.search(path) or GUARD.search(path))


def strip_comments(command):
    return COMMENT.sub(lambda m: m.group(1) or "", command)


def segments(command):
    lex = shlex.shlex(command, posix=True, punctuation_chars=";&|<>()\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    lex.commenters = ""
    try:
        words = list(lex)
    except ValueError:
        words = command.split()
    current = []
    for word in words:
        if word and set(word) <= OPERATOR:
            yield current
            current = []
        else:
            current.append(word)
    yield current


def redirect_targets(words):
    return [words[i + 1] for i, w in enumerate(words[:-1])
            if set(w) <= set("<>&|") and ">" in w and not w.endswith("&") and not w.startswith("<")]


def options_contain(words, short, long):
    return any(w.startswith(long) or (re.match(r"^-[A-Za-z]*" + short, w) and not w.startswith("--"))
               for w in words)


def program(words):
    while words and (words[0] in PREFIXES or re.match(r"^\w+=", words[0])):
        words = words[1:]
    return (os.path.basename(words[0]), words[1:]) if words else ("", [])


def git_subcommand(args):
    while args and args[0] in ("-C", "-c"):
        args = args[2:]
    return (args[0], args[1:]) if args else ("", [])


def inline_code(name, args):
    flag = "-c" if name.startswith("python") else "-e"
    return [args[i + 1] for i, a in enumerate(args[:-1])
            if a == flag or (name == "perl" and re.match(r"^-[A-Za-z]*[eE]$", a))]


def script_writes(code):
    return [m for statement in re.split(r"[;\n]", code)
            for target in [COPY_SOURCE.sub(r"\1", statement)] if SCRIPT_WRITE.search(target)
            for m in MENTION.findall(target)]


def written(words, heredocs):
    hits = [t for t in redirect_targets(words) if protected(t)]
    name, args = program([w for w in words if not (set(w) <= set("<>&|"))])
    named = [a for a in args if protected(a)]
    if name in OPERAND_WRITERS or (name == "sed" and options_contain(args, "i", "--in-place")):
        hits += named
    elif name == "cp":
        operands = [a for a in args if not a.startswith("-")]
        hits += [operands[-1]] if operands and protected(operands[-1]) else []
    elif name == "git":
        sub, rest = git_subcommand(args)
        if sub in GIT_PATH_WRITERS:
            hits += [a for a in rest if protected(a)]
        elif sub in ("apply", "am") and not {"--check", "--stat", "--numstat"} & set(rest):
            hits += MENTION.findall("\n".join(heredocs))
    elif name in ("bash", "sh", "zsh") and "-c" in args[:-1]:
        hits += shell_writes(args[args.index("-c") + 1])
    elif name == "perl" and options_contain([a for a in args if a.startswith("-")], "i", "--in-place"):
        hits += named
    elif re.match(r"^(python[\d.]*|perl)$", name):
        hits += [m for code in inline_code(name, args) + heredocs for m in script_writes(code)]
    return hits


def shell_writes(command):
    heredocs = [m.group(4) for m in HEREDOC.finditer(command)]
    bare = strip_comments(HEREDOC.sub(r"\1", command))
    return list(dict.fromkeys(hit for words in segments(bare) for hit in written(words, heredocs)))


def flow(paths):
    guard = [p for p in paths if GUARD.search(p)]
    return " ".join(([SPEC_FLOW] if len(guard) < len(paths) else []) + ([GUARD_FLOW] if guard else []))


def decide(decision, reason):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse",
                                             "permissionDecision": decision,
                                             "permissionDecisionReason": reason}}))


def main(data):
    tool_input = data.get("tool_input") or {}
    subagent = is_subagent(data)
    if data.get("tool_name") == "Bash":
        hits = shell_writes(tool_input.get("command") or "")
        if hits and subagent:
            decide("deny", f"This command writes {', '.join(hits)}. {flow(hits)}")
        elif hits:
            decide("ask", f"This command writes {', '.join(hits)}, which the maintainer owns. "
                          "Approve it only if it applies text you approved.")
        return
    path = tool_input.get("file_path") or tool_input.get("notebook_path") or ""
    if subagent and protected(path):
        decide("deny", f"{path}: {flow([path])}")


if __name__ == "__main__":
    main(json.load(sys.stdin))
