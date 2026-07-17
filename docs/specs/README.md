# Surface Specs

One living spec per Modbench UI surface. A **surface** is a top-level UI unit the user experiences as a tab/view — usually smaller than a bounded context (Downloads and Mods both belong to Mod Management).

| Spec | Surface | Status |
|---|---|---|
| [mods.md](mods.md) | Mods (Loadout) — install, order, enable, deploy | Implemented |
| [plugins.md](plugins.md) | Plugins (load order) — enable/reorder `plugins.txt` | Specced — ready to build |
| [downloads.md](downloads.md) | Downloads — Nexus integration, download queue | Specced — MVP ready to build |
| [medit.md](medit.md) | **mEdit — context overview** (session lifecycle, status bar, command palette, seams). Not a surface | Implemented |
| [medit-plugins-tree.md](medit-plugins-tree.md) | mEdit Plugins tree — navigate records; SQL record filter | Implemented |
| [medit-record-editor.md](medit-record-editor.md) | mEdit Record editor panel — compare grid, in-place editing, Pending column | Implemented; edit-mode removal + Pending column actions specced |
| [medit-referenced-by.md](medit-referenced-by.md) | mEdit Referenced By panel — what points at this record | Implemented |
| [medit-pending-changes-tree.md](medit-pending-changes-tree.md) | mEdit Pending Changes tree — what must be saved or reverted together | Specced — needs re-slicing (ADR-0029) |

A view spanning several surfaces gets one **context overview** plus one spec per surface —
[medit.md](medit.md) is the worked example. The overview holds only what is genuinely shared
(lifecycle, cross-cutting seams) and never duplicates a surface's own spec.

## How specs relate to PRDs and issues

| Layer | Tense | Lives | Lifecycle |
|---|---|---|---|
| **Surface spec** (this directory) | Present — "what this surface does" | Repo | Living; updated when an initiative ships |
| **PRD** — one per initiative | Future — "what we're building and why" | GitHub issue (`/to-spec`) | Spent when its slices ship |
| **Issue** — vertical slice of a PRD | Imperative | GitHub issue (`/to-tickets`) | Closed on merge |

Rules:

- A spec describes **current behavior** plus clearly-marked planned sections. It is the source of truth for its surface: before building new UI on a surface, read its spec; when an initiative changes intended behavior, **update the spec first**.
- When an initiative's slices ship, **fold the outcome back into the surface spec** — a spec that lags the product is a bug.
- Specs use the vocabulary of their bounded context (see [CONTEXT-MAP.md](../../CONTEXT-MAP.md)); the "why" behind structural choices lives in [docs/adr/](../adr/), not here.

The roadmap is the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) epic board — each milestone is an epic, its issues are the slices.
