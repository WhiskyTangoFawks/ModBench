# Python scripts are HTTP clients of the backend, not a backend-spawned subprocess

*This ADR's central decision — scripts are HTTP clients of the backend, never a spawned
subprocess — still governs (CONTEXT.md cites it as current). [ADR-0041](0041-manual-git-tracking-compile-from-text.md)
retired the pending-change mechanism the body below describes `edit()` as landing in;
`edit()` now writes through the same working-tree edit path a manual edit uses
(`POST /records/{formKey}/field`), and reads go through the generated `json_extract`
views (ADR-0025 is superseded), not a `pending_changes` overlay. The transport
decision and its rationale are otherwise unaffected.*

The Phase 15 scripting engine runs Python scripts as **HTTP clients of the existing backend**. A small `medit` Python package wraps the same endpoints the VS Code extension uses; scripts are just a second client of the same API. The backend does not spawn Python and does not own a script-execution endpoint.

This supersedes the earlier Phase 15 design (and an [ADR-0014](0014-python-for-scripting.md) consequence) in which the backend spawned a Python subprocess and exchanged JSON-RPC over stdin/stdout via `POST /script/run`.

## Decision

A script's two needs map onto the existing API:

- **Selection** — `POST /query` runs a SQL SELECT against the pending-overlay views ([ADR-0025](0025-reads-overlay-pending-via-views.md)) and returns `{ columns, rows }`. SELECT-only; no DDL/DML.
- **Writes** — `edit()` calls the existing stage endpoint (`PATCH /records/{fk}`) with `source: "script"`, landing in `PendingChangeService` exactly like a manual edit.

The same model already governs the ADR-0018 record filter: humans and agents send identical SQL to the same endpoint, with no separate data path. Scripts extend that — one transport, one data path.

## Why this is the right choice

- **Staging is respected by construction.** Edits flow through the same stage pipeline as manual edits, so the user's review/approve/discard gate is unavoidable. A script cannot bypass it because it never touches the write pipeline directly.
- **Zero Mutagen access.** Scripts see JSON over HTTP; the C# endpoints remain the only code touching Mutagen.
- **No raw shared-DB writes.** Routing through the stage endpoint preserves `ColumnSpec.Apply` validation and reference-validation-at-stage-time (ADR-0020). A direct DuckDB handle would let a script write `pending_changes` (or worse) and bypass both.
- **Runs anywhere.** Scripts run from the extension's "Run Script" command, a terminal, a REPL, a notebook, or CI, and debug with normal Python tooling. The extension command is a convenience that spawns `python script.py` with the backend URL in env.
- **Less to build.** No bespoke JSON-RPC protocol, no subprocess lifecycle/stdout capture in the backend, no `POST /script/run`. The only net-new backend surface is `POST /query`.

## Consequences

- The backend gains `POST /query` (SELECT-only). It does **not** gain `POST /script/run`, and script discovery is an extension-side filesystem listing, not a backend endpoint.
- The `medit` package owns frontmatter parsing, client-side token substitution, row objects, and mapping `StageEditResult` problem responses to Python exceptions.
- Heavy script compute (temp tables, aggregation) lives in the script's own in-memory DuckDB/pandas — never the shared index.

## Considered options

**Backend-spawned subprocess, JSON-RPC over stdin/stdout** (the original Phase 15 plan) — inverts control so the backend drives execution, but invents a second transport protocol, puts subprocess lifecycle and stdout capture in the backend, and confines scripts to being launched by the extension. Rejected.

**Direct DuckDB handle to Python** — fast reads, but DuckDB is single-writer (C# holds the connection) so it can't write anyway, and any write path it did have would bypass staging and validation. Rejected.

**gRPC** — a second transport surface plus codegen for TypeScript and Python, to move SQL-filtered result sets that HTTP+JSON already handles. Over-engineered. Rejected.

**Embed CPython in-process (pythonnet) / Pyodide in the extension** — removes the boundary but brings GIL and deployment pain, and denies users their real venv (numpy, pandas, …). Rejected.
