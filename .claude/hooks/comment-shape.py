#!/usr/bin/env python3
"""Structural comment checks Vale cannot express: doc block over three lines, doc comment on a
test method, on a private member, or a ticket-number citation anywhere. Exit 1 on any hit.

Usage: comment-shape.py FILE...            check files
       comment-shape.py --as PATH < text   check a fragment as if it were PATH"""
import re
import sys

MAX_LINES = 3
TEST_FILE = re.compile(r"(Tests\.cs|\.test\.tsx?)$")
CS_METHOD = re.compile(r"^\s*(?:public|private|internal|protected|static|async|override|virtual)\b[\w<>\[\],.?\s]*\s\w+\s*(?:<[^>]*>)?\s*\(")
TS_TEST_METHOD = re.compile(r"^\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|(?:export\s+)?(?:async\s+)?function\s+\w+|(?:public|private|protected|static|async|\s)*\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{)")
TS_TOP_LEVEL_DECL = re.compile(r"^(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract class)\s")
# Our tracker's numbers have never been single-digit; a lone digit is an in-document enumeration
# (divergence #2, AC #4), never a ticket.
TICKET = re.compile(r"#\d{2,}\b")
# A number is an external tracker's, not ours, when a tracker name or owner/repo path sits right
# before it, with only that name's own separators between: "Mutagen #688", "Mutagen-#688",
# "Mutagen-Modding/Mutagen#688", "upstream #685/#686" chained across the slash.
EXTERNAL_TICKET = re.compile(
    r"\b(?:Mutagen|upstream|VS ?Code)\b[\w ./-]{0,20}?#\d+(?:\s*/\s*#\d+)*"
    r"|[\w.-]+/[\w.-]+#\d+")
# A hex colour is a hash-digit run that is the entire quoted literal, or sits right after the
# comma in a `var(--x, #fff)` fallback — never a bare, unquoted "#NNN" or "(#NNN)".
HEX_COLOR = re.compile(r",\s*#[0-9a-fA-F]{3,8}\s*\)|['\"`]#[0-9a-fA-F]{3,8}['\"`]")


def ticket_hits(path, lines):
    hits = []
    for lineno, line in enumerate(lines, start=1):
        exempt = [m.span() for m in EXTERNAL_TICKET.finditer(line)]
        exempt += [m.span() for m in HEX_COLOR.finditer(line)]
        for m in TICKET.finditer(line):
            if any(s <= m.start() and m.end() <= e for s, e in exempt):
                continue
            hits.append(f"{path}:{lineno}: ticket number '{m.group(0)}' — cite it in the commit message, not the code")
    return hits


def doc_blocks(lines, is_cs):
    """Yield (start, end) 0-based inclusive line ranges of /// or /** blocks."""
    i = 0
    while i < len(lines):
        s = lines[i].lstrip()
        if is_cs and s.startswith("///"):
            start = i
            while i + 1 < len(lines) and lines[i + 1].lstrip().startswith("///"):
                i += 1
            yield start, i
        elif not is_cs and s.startswith("/**") and not s.startswith("/**/"):
            start = i
            while i < len(lines) and "*/" not in lines[i]:
                i += 1
            if i < len(lines):
                yield start, i
        i += 1


def next_code_line(lines, after):
    in_attribute = False
    for j in range(after + 1, len(lines)):
        s = lines[j].strip()
        if in_attribute or s.startswith("["):
            in_attribute = not s.endswith("]")
            continue
        if not s or s.startswith("//") or s.startswith("*"):
            continue
        return lines[j]
    return ""


def check(path, text):
    lines = text.splitlines()
    hits = ticket_hits(path, lines)
    is_cs = path.endswith(".cs")
    if not (is_cs or path.endswith((".ts", ".tsx"))):
        return hits
    for start, end in doc_blocks(lines, is_cs):
        where = f"{path}:{start + 1}"
        n = end - start + 1
        if n > MAX_LINES:
            hits.append(f"{where}: doc comment is {n} lines; the cap is {MAX_LINES}")
        target = next_code_line(lines, end)
        stripped = target.strip()
        if is_cs:
            if stripped.startswith("private"):
                hits.append(f"{where}: doc comment on a private member")
            if TEST_FILE.search(path) and CS_METHOD.match(target) and not re.search(r"\b(class|record|struct|interface|enum)\b", target):
                hits.append(f"{where}: doc comment on a test method")
        else:
            if stripped.startswith("private ") or (TS_TOP_LEVEL_DECL.match(target) and not target.startswith("export")):
                hits.append(f"{where}: doc comment on a private member")
            if TEST_FILE.search(path) and TS_TEST_METHOD.match(target):
                hits.append(f"{where}: doc comment on a test method")
    return hits


def main(argv):
    hits = []
    if argv[:1] == ["--as"]:
        hits = check(argv[1], sys.stdin.read())
    else:
        for path in argv:
            with open(path, encoding="utf-8", errors="replace") as f:
                hits.extend(check(path, f.read()))
    for h in hits:
        print(h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
