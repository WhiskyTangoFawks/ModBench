---
status: accepted
---

# One Plugins tree: the Plugin load order is the surface, editing is a capability of it

Amends [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md) (which originally kept two
Plugins trees) and [ADR-0018](0018-sql-file-based-record-filter.md) (whose pruning rule changes).

## Context

Two views called "Plugins" once occupied the same sidebar slot under mutually exclusive view-mode
clauses: Mod Management's plugin list and the editing record browser. The user experienced one
view whose contents swapped, and entering editing hid the Mods tree and the load order, so you
lost sight of the loadout you were patching against.

ADR-0027 rejected folding them together on two grounds: it conflates two bounded contexts, and it
would tie load-order editing to backend lifecycle. Both are answered below, and the reason they
are answerable is a change in the loading model rather than a change of mind about the boundary.
The investigation on #241 found that the expensive operation is *reload*, not *mutation*:
`load_order_idx` is a plain column and `UpdateWinners()` is a `MAX(load_order_idx) per form_key`
sweep, so a reorder is an `UPDATE` plus a sweep — no Mutagen re-read, no re-parse.

## Decision

**There is one Plugins tree.** It is always present, it is a Mod-Management surface that owns the
Plugin load order, and a running backend adds record browsing to its rows. There is no view mode.

### The loading model

**The editing session indexes everything named in `plugins.txt` — enabled and disabled alike.**
Plugin files that `plugins.txt` does not name (never-listed files, and copies shadowed by a
higher-priority mod) are indexed lazily, on demand.

The line is drawn by one rule: **anything that participates in winner computation must be loaded
eagerly and together; anything that does not can arrive whenever it is asked for.**
`UpdateWinners()` is a whole-set sweep, so a participating plugin arriving late invalidates every
conflict classification already on screen. A non-participating one changes nothing when it arrives.

**Participation is the checkbox.** A row's `plugins.txt` `*` prefix means it loads in the game and
competes for winner; nothing else does. `UpdateWinners()` and `ConflictClassifier` carry a
participation predicate — indexed rows that do not participate can never be a winner. This is the
one genuinely new invariant this ADR creates, and it is load-bearing: without it `is_winner`
describes a load order the game does not have. Session membership is not a choice a user makes.

### The tree

- Rows are `plugins.txt`'s lines, in Plugin load order, plus lazily-added non-participating files.
- With no backend the rows are leaves. Starting the backend makes them collapsible — chevrons
  appear across the tree, which is the whole of the "editing is available now" signal.
- **The leading slot answers exactly one question — "can you change whether this loads?"**: a
  checkbox where you decide, a lock on an implicit master that is forced on, nothing at all on a
  file that is not in the load order. Read-only-for-editing is never an icon; it is conveyed by
  absent actions and the tooltip.
- Non-participating copies render dimmed and read-only, behind a single global show/hide toggle.
  Hidden means **absent** — from the tree and from the compare grid's columns alike — not
  collapsed. Unloading is `IRecordIndexer.Unindex`, never filtering.

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

Reorder, enable and disable **apply live and unprompted**, with a view-header progress indicator
as the only feedback. All three are SQL-only: an `UPDATE` of `load_order_idx` or of the
participation flag, plus a winner re-sweep. Nothing is re-read and the connection is unchanged.

When a mod-level change (install, uninstall, reprioritise) alters which physical file a plugin
name resolves to, the session **re-reads that plugin automatically** — the same absorption every
other loadout gesture gets, with the ordinary progressive-load presentation while it happens. VS
Code's own file model is the precedent: a clean buffer follows the disk silently. A tracked
plugin's content comes from its source, not the binary (ADR-0041), so its working-tree edits are
untouched by a re-read; a name that comes to resolve to nothing is the existing missing-plugin
state.

**Loading is progressive and states its own incompleteness.** A plugin's records are browsable
the moment that plugin is indexed, but conflict information is not correct until the final winner
sweep. Rows gain chevrons as they land, and the view carries an explicit "conflict information not
yet computed" message until the sweep completes. An absent conflict badge must never be mistakable
for "no conflict".

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
- Startup cost grows — the eager set gains every disabled entry — which puts pressure on
  ADR-0001's no-cache position without changing it.
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
- **Index every plugin file on disk eagerly** — no session cache (ADR-0001), so the cost is paid
  in full on every launch, and the population is unbounded.
- **Index only enabled plugins** — makes enabling a plugin an indexing stall rather than a SQL
  update, forfeiting the live mutation that is the point of the merge.
- **Flag mod-level changes as "drift" and offer a manual re-read** — its rationale only covered
  the retired staged-edits case; "drift" was inventory of that refusal, not a concept a user wants.
- **Never remove a plugin row under a record filter** — sound for the plugin-name filter (applied
  mid-reorder, needing the whole order in view), not for the record filter, whose whole point is to
  cut noise and whose clearing restores everything.
