---
status: accepted
---

# Python scripts are HTTP clients of the backend, not a backend-spawned subprocess

Scripts run as **HTTP clients of the existing backend**. A small `medit` Python package wraps the
same endpoints the VS Code extension uses; scripts are just a second client of the same API. The
backend does not spawn Python and does not own a script-execution endpoint.

## Decision

A script's two needs map onto the existing API:

- **Selection** — `POST /query` runs a SQL SELECT against the generated per-type views
  (ADR-0005) and returns `{ columns, rows }`. SELECT-only; no DDL/DML.
- **Writes** — `edit()` calls the same field-write door a manual edit uses
  (`POST /records/{formKey}/field`), landing as a working-tree change in the tracked mod's source
  ([ADR-0041](0041-manual-git-tracking-compile-from-text.md)).

The same model already governs the ADR-0018 record filter: humans and agents send identical SQL
to the same endpoint, with no separate data path. Scripts extend that — one transport, one data
path.

## Why this is the right choice

- **The edit path is respected by construction.** A script's writes go through the same
  validation (`ColumnSpec.Apply`, edit-time FormLink checks) and the same tracked-mod refusal a
  manual edit does, and land as reviewable git dirt. A script cannot bypass any of it because it
  never touches the write pipeline directly.
- **Zero Mutagen access.** Scripts see JSON over HTTP; the C# endpoints remain the only code
  touching Mutagen.
- **No raw shared-DB writes.** DuckDB is single-writer (C# holds the connection); a direct handle
  would let a script bypass validation.
- **Runs anywhere.** Scripts run from the extension's "Run Script" command, a terminal, a REPL, a
  notebook, or CI, and debug with normal Python tooling. The extension command is a convenience
  that spawns `python script.py` with the backend URL in env.
- **Less to build.** No bespoke JSON-RPC protocol, no subprocess lifecycle/stdout capture in the
  backend. The only net-new backend surface is `POST /query`.

## Consequences

- Script discovery is an extension-side filesystem listing, not a backend endpoint.
- The `medit` package owns row objects and mapping problem responses to Python exceptions.
- Heavy script compute (temp tables, aggregation) lives in the script's own in-memory
  DuckDB/pandas — never the shared index.

## Alternatives rejected

- **Backend-spawned subprocess, JSON-RPC over stdin/stdout** (the original plan, once an
  ADR-0014 consequence) — inverts control so the backend drives execution, but invents a second
  transport protocol, puts subprocess lifecycle and stdout capture in the backend, and confines
  scripts to being launched by the extension.
- **Direct DuckDB handle to Python** — fast reads, but it can't write anyway (single-writer), and
  any write path it did have would bypass validation.
- **gRPC** — a second transport surface plus codegen for TypeScript and Python, to move
  SQL-filtered result sets that HTTP+JSON already handles.
- **Embed CPython in-process (pythonnet) / Pyodide in the extension** — removes the boundary but
  brings GIL and deployment pain, and denies users their real venv (numpy, pandas, …).
