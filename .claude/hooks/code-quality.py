#!/usr/bin/env python3
"""Stop hook: surface analyzer diagnostics on the files edited this turn.

Gives the agent per-turn, diff-scoped code-quality feedback across both stacks
instead of waiting for /validate:

- Backend (C#): builds each changed analyzed project with a SARIF error log,
  capturing *all* severities incl. the info/note rules (Sonar complexity, RCS,
  IDE...) that never appear in normal `dotnet build` output.
- Frontend (TypeScript): runs ESLint on changed .ts/.tsx, capturing errors and
  the `sonarjs`/complexity warnings that gate the extension-host logic.

Design notes:
- Fires once per settle cycle (stop_hook_active guard) so it never nags or loops;
  /validate stays the hard gate. Advisory, matching the repo's "visible-but-not-
  blocking, per-instance triage" stance on quality rules.
- Everything is scoped to files changed vs HEAD, so it reports on your work, not
  the whole codebase.
"""
import json
import os
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import url2pathname

# --- Backend: analyzed C# projects, keyed by repo-relative source dir. --------
CS_PROJECTS = {
    "MEditService/MEditService.Core": "MEditService.Core",
    "MEditService/MEditService.Api": "MEditService.Api",
}
# --- Frontend: extension package that carries the ESLint config. --------------
TS_PACKAGE = "modbench"
TS_IGNORE = ("src/generated/", "out/", "webview/dist/", "node_modules/")

MAX_LINES = 40  # cap feedback so a large backlog can't flood the turn


def repo_root() -> str:
    env = os.environ.get("CLAUDE_PROJECT_DIR")
    if env:
        return env
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def changed_files(root: str) -> list[str]:
    """Repo-relative paths differing from HEAD (staged + unstaged)."""
    try:
        out = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=root, capture_output=True, text=True, timeout=15,
        ).stdout
    except (subprocess.SubprocessError, OSError):
        return []
    return out.splitlines()


# ---------------------------------------------------------------- backend (C#)
def cs_projects_for(files: list[str]) -> dict[str, str]:
    hit = {}
    for f in files:
        if not f.endswith(".cs"):
            continue
        for prefix, name in CS_PROJECTS.items():
            if f.startswith(prefix + "/"):
                hit[name] = os.path.join("MEditService", name, name + ".csproj")
    return hit


def build_sarif(root: str, csproj: str, sarif_path: str) -> None:
    """Compile one project in isolation, emitting a SARIF error log.

    Every flag is load-bearing for reliably capturing diagnostics:
      --no-incremental        an up-to-date build is a no-op and emits no SARIF.
      UseSharedCompilation=false  the persistent Roslyn build server caches
                              analyzer results, so even --no-incremental hands
                              back an empty log; a fresh out-of-process csc
                              re-runs analyzers and populates the SARIF.
      --no-dependencies       keep the compile to just this project.
    """
    subprocess.run(
        ["dotnet", "build", os.path.join(root, csproj),
         "--no-dependencies", "--no-incremental",
         "-p:UseSharedCompilation=false",
         "-v", "quiet", f"-p:ErrorLog={sarif_path},version=2.1"],
        cwd=root, capture_output=True, text=True, timeout=180,
    )


def read_sarif(sarif_path: str) -> list[dict]:
    if not os.path.exists(sarif_path):
        return []
    try:
        with open(sarif_path) as fh:
            doc = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []
    out = []
    for run in doc.get("runs", []):
        for res in run.get("results", []):
            loc = (res.get("locations") or [{}])[0]
            # SARIF v2.1 nests uri under physicalLocation.artifactLocation;
            # MSBuild's default (v1) puts it under resultFile. Support both.
            phys = loc.get("physicalLocation", loc.get("resultFile", {}))
            uri = phys.get("artifactLocation", {}).get("uri") or phys.get("uri")
            if not uri:
                continue
            msg = res.get("message", {})
            if isinstance(msg, dict):
                msg = msg.get("text", "")
            out.append({
                "path": url2pathname(urlparse(uri).path),
                "line": phys.get("region", {}).get("startLine", 0),
                "level": res.get("level", "note"),
                "rule": res.get("ruleId", "?"),
                "msg": (msg or "").strip(),
            })
    return out


def backend_findings(root: str, changed: list[str]) -> list[dict]:
    targets = cs_projects_for(changed)
    if not targets:
        return []
    changed_abs = {os.path.realpath(os.path.join(root, f))
                   for f in changed if f.endswith(".cs")}
    found = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, csproj in targets.items():
            sarif = os.path.join(tmp, name + ".sarif")
            build_sarif(root, csproj, sarif)
            for r in read_sarif(sarif):
                if os.path.realpath(r["path"]) in changed_abs:
                    found.append(r)
    return found


# ------------------------------------------------------------- frontend (TS)
ESLINT_LEVEL = {2: "error", 1: "warning"}


def frontend_findings(root: str, changed: list[str]) -> list[dict]:
    pkg_prefix = TS_PACKAGE + "/"
    rel = [f[len(pkg_prefix):] for f in changed
           if f.startswith(pkg_prefix)
           and f.rsplit(".", 1)[-1] in ("ts", "tsx")
           and not any(f[len(pkg_prefix):].startswith(i) for i in TS_IGNORE)]
    if not rel:
        return []
    pkg_dir = os.path.join(root, TS_PACKAGE)
    eslint = os.path.join(pkg_dir, "node_modules", ".bin", "eslint")
    if not os.path.exists(eslint):
        return []
    try:
        proc = subprocess.run(
            [eslint, "--format", "json", *rel],
            cwd=pkg_dir, capture_output=True, text=True, timeout=120,
        )
    except (subprocess.SubprocessError, OSError):
        return []
    try:
        report = json.loads(proc.stdout)
    except (json.JSONDecodeError, ValueError):
        return []
    found = []
    for filerep in report:
        path = filerep.get("filePath", "")
        for m in filerep.get("messages", []):
            if not m.get("ruleId"):  # skip parser/ignored-file notices
                continue
            found.append({
                "path": path,
                "line": m.get("line", 0),
                "level": ESLINT_LEVEL.get(m.get("severity"), "note"),
                "rule": m["ruleId"],
                "msg": (m.get("message", "") or "").strip(),
            })
    return found


# ------------------------------------------------------------------- reporting
def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except (json.JSONDecodeError, ValueError):
        payload = {}
    # Fire once per settle cycle: after we report and the agent responds, the
    # next Stop carries stop_hook_active=True — let it stop.
    if payload.get("stop_hook_active"):
        return 0

    root = repo_root()
    changed = changed_files(root)
    if not changed:
        return 0

    findings = backend_findings(root, changed) + frontend_findings(root, changed)
    if not findings:
        return 0

    rank = {"error": 0, "warning": 1, "note": 2, "none": 3}
    findings.sort(key=lambda r: (rank.get(r["level"], 4), r["path"], r["line"]))
    seen, unique = set(), []
    for r in findings:
        key = (r["path"], r["line"], r["rule"])
        if key not in seen:
            seen.add(key)
            unique.append(r)

    lines = []
    for r in unique[:MAX_LINES]:
        rel = os.path.relpath(r["path"], root)
        lines.append(f"  {rel}:{r['line']}  {r['rule']} [{r['level']}]  {r['msg']}")
    extra = len(unique) - MAX_LINES
    if extra > 0:
        lines.append(f"  ... and {extra} more")

    counts = {}
    for r in unique:
        counts[r["level"]] = counts.get(r["level"], 0) + 1
    summary = ", ".join(f"{n} {lvl}" for lvl, n in sorted(counts.items()))

    print(
        "Code-quality signal on the files you just changed "
        f"({summary}) — backend Sonar/analyzer diagnostics (incl. info-level "
        "notes that don't show in a normal build) and frontend ESLint/sonarjs:\n\n"
        + "\n".join(lines) + "\n\n"
        "Advisory, not a gate. Fix the ones in scope for this change now; leave "
        "pre-existing/out-of-scope ones for /validate triage. Acknowledge and "
        "stop if none apply — this won't fire again this turn.",
        file=sys.stderr,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
