#!/usr/bin/env python3
"""Structural comment checks Vale cannot express: doc block over three lines, doc comment on a
test method, on a private member, or carrying more than one cref. Exit 1 on any hit.

Usage: comment-shape.py FILE...            check files
       comment-shape.py --as PATH < text   check a fragment as if it were PATH"""
import re
import sys

MAX_LINES = 3
TEST_FILE = re.compile(r"(Tests\.cs|\.test\.tsx?)$")
CS_METHOD = re.compile(r"^\s*(?:\[.*\]\s*)?(?:public|private|internal|protected|static|async|override|virtual|\s)*[\w<>\[\],.?]+\s+\w+\s*(?:<[^>]*>)?\s*\(")
TS_TEST_METHOD = re.compile(r"^\s*(?:(?:it|test|describe)(?:\.\w+)?\s*\(|(?:export\s+)?(?:async\s+)?function\s+\w+|(?:public|private|protected|static|async|\s)*\w+\s*\([^)]*\)\s*(?::\s*[^{]+)?\{)")
TS_TOP_LEVEL_DECL = re.compile(r"^(?:async\s+)?(?:function|const|let|class|interface|type|enum|abstract class)\s")
CREF = re.compile(r"cref=|\{@link\s")


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
            yield start, min(i, len(lines) - 1)
        i += 1


def next_code_line(lines, after):
    for j in range(after + 1, len(lines)):
        s = lines[j].strip()
        if not s or s.startswith("//") or s.startswith("*") or (s.startswith("[") and s.endswith("]")):
            continue
        return lines[j]
    return ""


def check(path, text):
    is_cs = path.endswith(".cs")
    if not (is_cs or path.endswith((".ts", ".tsx"))):
        return []
    lines = text.splitlines()
    hits = []
    for start, end in doc_blocks(lines, is_cs):
        where = f"{path}:{start + 1}"
        n = end - start + 1
        if n > MAX_LINES:
            hits.append(f"{where}: doc comment is {n} lines; the cap is {MAX_LINES}")
        block = "\n".join(lines[start:end + 1])
        if len(CREF.findall(block)) > 1:
            hits.append(f"{where}: more than one cref in a doc comment")
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
            try:
                with open(path, encoding="utf-8", errors="replace") as f:
                    hits.extend(check(path, f.read()))
            except FileNotFoundError:
                continue
    for h in hits:
        print(h)
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
