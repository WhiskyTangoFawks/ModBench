---
status: accepted
---

# One Plugins tree: the Plugin load order is the surface, editing is a capability of it

Amends [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md) (which kept two
Plugins trees) and [ADR-0018](0018-sql-file-based-record-filter.md) (whose pruning rule changes).

## Context

Two views called "Plugins" once occupied the same sidebar slot under mutually exclusive view-mode
clauses: Mod Management's plugin list and the editing record browser. The user experienced one
view whose contents swapped, and entering editing hid the Mods tree and the load order, so you
lost sight of the loadout you were patching against.

ADR-0027 rejected folding them together on two grounds: it conflates two bounded contexts, and it
would tie load-order editing to backend lifecycle. Both are answered below, and the reason they
are answerable is a change in the loading model rather than a change of mind about the boundary.
Investigation found that the expensive operation is *reload*, not *mutation*:
`load_order_idx` is a plain column and `UpdateWinners()` is a `MAX(load_order_idx) per form_key`
sweep, so a reorder is an `UPDATE` plus a sweep — no Mutagen re-read, no re-parse.

## Decision

**There is one Plugins tree.** It is always present, it is a Mod-Management surface that owns the
Plugin load order, and a running backend adds record browsing to its rows. There is no view mode.

### The loading model

Per [ADR-0044](0044-the-load-order-is-mirrored-not-loaded.md): **every
physical plugin copy in the instance is registered** — the copies `plugins.txt` names, enabled
and disabled alike, the copies losing the Mod override order, and files no line names. There is
no lazy, on-demand path: a copy is in the index because it exists, and whether it competes is a
separate fact.

**Participation is derived: `enabled AND winning AND listed`.** A row's `plugins.txt` `*` prefix
(`enabled`), whether the Mod override order resolves its name to this copy (`winning`), and
whether any line names it at all are three facts on the registration row, all supplied by Mod
Management. `UpdateWinners()` and `ConflictClassifier` carry the participation predicate —
registered rows that do not participate can never be a winner. This is the load-bearing
invariant: without it `is_winner` describes a load order the game does not have. Registration is
not a choice a user makes; participation is three choices they already made in Loadout.

### The tree

- Rows are `plugins.txt`'s lines, in Plugin load order.
- With no backend the rows are leaves. Starting the backend makes them collapsible — chevrons
  appear across the tree, which is the whole of the "editing is available now" signal.
- **The leading slot answers exactly one question — "can you change whether this loads?"**: a
  checkbox where you decide, a lock on an implicit master that is forced on, nothing at all on a
  file that is not in the load order. Read-only-for-editing is never an icon; it is conveyed by
  absent actions and the tooltip.
- Non-participating copies are registered ([ADR-0044](0044-the-load-order-is-mirrored-not-loaded.md))
  but **not displayed in the Plugins tree**: a copy losing the Mod override order, or one no
  `plugins.txt` line names, has no row, and a plugin more than one enabled mod provides renders
  exactly like any other row. (The compare grid still lists a losing copy as a dimmed non-winner
  column — a never-hide-data posture; whether that survives is part of the same open design.)
  A non-participating copy **never influences winners or conflicts**. How such copies surface — per-reason show/hide
  toggles, dimming, origin labelling — is an open UX design; an always-on Stack
  node and file-override badge were reviewed live and rejected.

### Filters

**A filter acts only on the level it names.** The plugin-name filter hides plugin rows. The record
filter prunes records and record types, and the tree **hides a plugin the active record filter
matches nothing of** — a visible-but-permanently-inert row was never the load order serving a
purpose; clearing the filter restores every row immediately, in load order. The backend never
prunes a plugin row itself: `GetPlugins()` returns every plugin with `HasMatchingRecords` as an
additive fact, and `PluginsTreeComposite` omits the row. Narrowing to a single plugin for
authoring is `Apply Filter to Selected`, adopted from xEdit's `mniNavFilterApplySelected` — the
ordinary record filter invoked against the tree selection, not a mode.

### Live mutation

Per [ADR-0044](0044-the-load-order-is-mirrored-not-loaded.md): every loadout
gesture — reorder, enable, disable, install, uninstall, reprioritise, profile switch — reaches
Editing the same way: Mod Management sends the whole Plugin load order as one idempotent snapshot
(`PUT /load-order`) and Editing reconciles it against its registration table. All of them are
SQL-only on a copy the mirror already holds: `UPDATE` of slot or flags, a winner re-sweep. A
mod-level change that moves which copy wins a name is the `winning` flag moving from one
registered row to another — nothing is re-read, because both copies were already indexed. Only a
copy the mirror has never seen is indexed, progressively, with the ordinary presentation. There
is no drift and no reread verb. VS Code's own file model is the precedent: a clean buffer follows
the disk silently.

**Loading is progressive.** A plugin's records are browsable the moment that plugin is indexed,
not held back until the whole load order settles. Rows gain chevrons as they land.

### View layout

Mods, Plugins and Downloads are visible always. Referenced By is **"Plugins - Referenced By"**: VS
Code has no view nesting within a container, so a title convention is the only available way to
say that a view is a sub-functionality of another.

### The bounded-context boundary

The merged provider is a thin composite at the composition root. **Mod Management owns the rows**
(identity, order, checkbox, origin); **`PluginRepository` owns the children** (record types,
records, conflicts, spatial navigation). Neither imports the other's vocabulary, and the composite
is not a third module that knows both — enforced by `src/test/contextBoundary.test.ts`.
ADR-0027's conflation objection is met structurally, not by assertion.

## Consequences

- A participation predicate in `UpdateWinners()` and in `ConflictClassifier`'s load-order-index
  comparison is the correctness centre of the design.
- Startup cost grows — the eager set gains every disabled entry. ADR-0001's persistent index
  absorbs it: the index is a per-instance file and a load order is a registration over it.
- `CONTEXT.md` names the three narrowing axes explicitly (plugin-name filter, record filter,
  non-participating visibility) so a fourth term does not get invented. "Focus" is deliberately
  **not** a term.

## Alternatives rejected

- **Two Plugins views behind a view mode** (the original design) — one sidebar slot whose contents
  swapped, hiding the loadout during editing.
- **Keep two views, stop hiding the loadout during editing** — a valid first step, not a
  destination: two co-visible views named "Plugins" force a rename the merge immediately undoes.
- **Master/detail: a Plugin List plus a record browser scoped by its selection** — separates the
  contexts cleanly, but xEdit navigates plugin → record in one tree and every user arrives fluent
  in that ([ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md)). Two panes is a
  real divergence with no platform limitation forcing it.
- **Index every plugin file on disk eagerly, without a persistent index** — pays the full cost
  on every launch. ADR-0001's persistent index removed that cost, and ADR-0044 adopts eager
  registration itself: every copy is registered, once, ever.
- **Index only enabled plugins** — makes enabling a plugin an indexing stall rather than a SQL
  update, forfeiting the live mutation that is the point of the merge.
- **Flag mod-level changes as "drift" and offer a manual re-read** — its rationale only covered
  the retired staged-edits case; "drift" was inventory of that refusal, not a concept a user wants.
  (The automatic re-read that replaced it is itself retired by ADR-0044: both copies are
  registered, so a mod-order change moves a flag rather than re-reading a file.)
- **Never remove a plugin row under a record filter** — sound for the plugin-name filter (applied
  mid-reorder, needing the whole order in view), not for the record filter, whose whole point is to
  cut noise and whose clearing restores everything.
