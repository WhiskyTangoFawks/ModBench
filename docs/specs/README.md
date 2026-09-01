# Surface Specs

One living spec per Modbench UI surface. A **surface** is a top-level UI unit the user experiences as a tab/view — usually smaller than a bounded context (Downloads and Mods both belong to Mod Management).

| Spec | Surface | Status |
|---|---|---|
| [loadout-header.md](loadout-header.md) | Loadout header — workspace-scope readout and action home (profile, load order, deployment) | Implemented; Launch… wiring deferred |
| [mods.md](mods.md) | Mods (Loadout) — install, order, enable, deploy | Implemented; executables-as-tasks specced |
| [plugins.md](plugins.md) | Plugins — the one Plugins tree: enable/reorder `plugins.txt` (Mod Management), plus record navigation and the SQL record filter whenever the backend is running (Editing) | Implemented |
| [downloads.md](downloads.md) | Downloads — Nexus integration, download queue | Implemented; `nxm://` handler pending |
| [medit.md](medit.md) | **mEdit — context overview** (load order lifecycle, status bar, command palette, seams). Not a surface | Implemented |
| [medit-record-editor.md](medit-record-editor.md) | mEdit Record editor panel — compare grid, in-place editing | Implemented |
| [medit-referenced-by.md](medit-referenced-by.md) | mEdit Referenced By tree — what points at this record | Implemented |
| [medit-version-control.md](medit-version-control.md) | Version control — Track, branch, compile — native Source Control panel review, Save & Compile, external-change handling | Implemented |
| [medit-repair.md](medit-repair.md) | Repair — diagnose a malformed plugin and, for defects with a CK-proven canonical form, rewrite it losslessly (or lossy by consent) so Mutagen can parse it | Specced — depends on the diagnosis floor |

A view spanning several surfaces gets one **context overview** plus one spec per surface —
[medit.md](medit.md) is the worked example. The overview holds only what is genuinely shared
(lifecycle, cross-cutting seams) and never duplicates a surface's own spec.

## How specs relate to PRDs and issues

| Layer | Tense | Lives | Lifecycle |
|---|---|---|---|
| **Surface spec** (this directory) | Present — "what this surface does" | Repo | Living; updated when an initiative ships |
| **PRD** — one per initiative | Future — "what we're building and why" | GitHub issue (`/to-spec`), labeled `ready-for-agent`; not a Milestone (can't carry a label) | Spent when its slices ship |
| **Issue** — vertical slice of a PRD | Imperative | GitHub issue (`/to-tickets`) | Closed on merge |

Rules:

- A spec describes **current behavior** plus clearly-marked planned sections. It is the source of truth for its surface: before building new UI on a surface, read its spec; when an initiative changes intended behavior, **update the spec first**.
- When an initiative's slices ship, **fold the outcome back into the surface spec** — a spec that lags the product is a bug.
- Specs use the vocabulary of their bounded context (see [CONTEXT-MAP.md](../../CONTEXT-MAP.md)); the "why" behind structural choices lives in [docs/adr/](../adr/), not here.

The roadmap is the [GitHub Milestones](https://github.com/WhiskyTangoFawks/ModBench/milestones) epic board — each milestone is an epic, its issues are the slices.
