# Surface Specs

One living spec per Modbench UI surface. A **surface** is a top-level UI unit the user experiences as a tab/view — usually smaller than a bounded context (Downloads and Mods both belong to Mod Management).

| Spec | Surface | Status |
|---|---|---|
| [mods.md](mods.md) | Mods (Loadout) — install, order, enable, deploy | Implemented |
| [plugins.md](plugins.md) | Plugins (load order) — enable/reorder/auto-sort `plugins.txt` | Planned |
| [medit.md](medit.md) | mEdit — view/edit/compare plugin records | Implemented |
| [downloads.md](downloads.md) | Downloads — Nexus integration, download queue | Planned |

## How specs relate to PRDs and issues

| Layer | Tense | Lives | Lifecycle |
|---|---|---|---|
| **Surface spec** (this directory) | Present — "what this surface does" | Repo | Living; updated when an initiative ships |
| **PRD** — one per initiative | Future — "what we're building and why" | GitHub issue (`/to-prd`) | Spent when its slices ship |
| **Issue** — vertical slice of a PRD | Imperative | GitHub issue (`/to-issues`) | Closed on merge |

Rules:

- A spec describes **current behavior** plus clearly-marked planned sections. It is the source of truth for its surface: before building new UI on a surface, read its spec; when an initiative changes intended behavior, **update the spec first**.
- When an initiative's slices ship, **fold the outcome back into the surface spec** — a spec that lags the product is a bug.
- Specs use the vocabulary of their bounded context (see [CONTEXT-MAP.md](../../CONTEXT-MAP.md)); the "why" behind structural choices lives in [docs/adr/](../adr/), not here.

The initiative queue and open surface questions live in [ROADMAP.md](../../ROADMAP.md).
