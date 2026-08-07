---
status: accepted
---

# One Plugins tree: the Plugin load order is the surface, editing is a capability of it

Amends [ADR-0027](0027-mo2-surfaces-map-to-native-vscode-views.md) (which rejected this) and
[ADR-0018](0018-sql-file-based-record-filter.md) (whose pruning rule changes).

## Context

Two views called "Plugins" occupy the same sidebar slot under mutually exclusive `viewMode`
clauses: the Mod-Management Plugin List (`modbench.pluginListTree`, `docs/specs/plugins.md`) and
the Editing Plugins tree (`modbench.pluginTree`, `docs/specs/medit-plugins-tree.md`). The user
already experiences one view whose contents swap. Entering editing also hides the Mods tree and
the Plugin load order, so you lose sight of the loadout you are patching against.

ADR-0027 rejected folding them together on two grounds: it conflates two bounded contexts, and it
would tie load-order editing to backend lifecycle when it should work without a spawned backend.
Both are now answered, and the reason they are answerable is a change in the loading model rather
than a change of mind about the boundary.

The investigation on
[#241](https://github.com/WhiskyTangoFawks/ModBench/issues/241) found that the expensive operation
is *reload*, not *mutation*: `load_order_idx` is a plain column and `UpdateWinners()` is a pure
`MAX(load_order_idx) per form_key` sweep, so a reorder is an `UPDATE` plus a sweep — no Mutagen
re-read, no re-parse, and the DuckDB connection never changes, so pending changes survive. What
blocked the merge was not cost but three structural conflicts, and all three are consequences of
the session being built from *enabled* plugins only.

## Decision

**There is one Plugins tree.** It is always present, it is a Mod-Management surface that owns the
Plugin load order, and a running backend adds record browsing to its rows. `modbench.viewMode`
retires.

### The loading model

**The editing session indexes everything named in `plugins.txt` — enabled and disabled alike.**
Plugin files that `plugins.txt` does not name (never-listed files, and copies shadowed by a
higher-priority mod) are indexed lazily, on demand.

The line is drawn by one rule: **anything that participates in winner computation must be loaded
eagerly and together; anything that does not can arrive whenever it is asked for.** `UpdateWinners()`
is a whole-set sweep, so a participating plugin arriving late invalidates every conflict
classification already on screen. A non-participating one changes nothing when it arrives.

**Participation is the checkbox.** A row's `plugins.txt` `*` prefix means it loads in the game and
competes for winner; nothing else does. `UpdateWinners()` and `ConflictClassifier` therefore gain a
participation predicate — indexed rows that do not participate can never be a winner. This is the
one genuinely new invariant this ADR creates, and it is load-bearing: without it `is_winner`
describes a load order the game does not have.

Session membership stops being a choice a user makes. Consequently there is no second checkbox, no
module-select, and no binding of session membership to `plugins.txt` to argue about — the question
dissolves rather than being answered.

### The tree

- Rows are `plugins.txt`'s lines, in Plugin load order, plus lazily-added non-participating files.
- With no backend the rows are leaves. Starting the backend makes them collapsible — chevrons
  appear across the tree, which is the whole of the "editing is available now" signal.
- **The leading slot answers exactly one question — "can you change whether this loads?"**:
  a checkbox where you decide, a lock on an implicit master that is forced on, nothing at all on a
  file that is not in the load order. Read-only-for-editing is never an icon; it is conveyed by
  absent actions and the tooltip. This resolves the standing contradiction between `plugins.md`
  (which refuses the lock because it misrepresents toggleability) and `medit-plugins-tree.md`
  (which uses it for read-only-ness) by giving the lock one meaning.
- Non-participating copies render dimmed and read-only, behind a single global show/hide toggle.
  Hidden means **absent** — from the tree and from the compare grid's columns alike — not collapsed.
  This is distinct from the per-column collapse of
  [#3](https://github.com/WhiskyTangoFawks/ModBench/issues/3); the two compose and neither is
  implemented in terms of the other.

### Filters

**A filter acts only on the level it names.** The plugin-name filter hides plugin rows. The record
filter prunes records and **never removes a plugin row** — a plugin with no matching records stays
visible and simply does not expand. This amends ADR-0018's "plugins and record types with no
matching records are hidden": in a tree that is also the load order, a filter that hides plugins
would make the load order unviewable and unreorderable mid-patch.

Narrowing to a single plugin for authoring is `Apply Filter to Selected`, adopted from xEdit's
`mniNavFilterApplySelected` — the ordinary record filter invoked against the tree selection. It is
not a mode, and it introduces no new term.

### Live mutation

Reorder, enable and disable **apply live and unprompted**, with a view-header progress indicator as
the only feedback. All three are SQL-only under this model: an `UPDATE` of `load_order_idx` or of
the participation flag, plus a winner re-sweep. Nothing is re-read, the connection is unchanged, and
staged edits survive.

Mod-level changes (install, uninstall, reprioritise) can change which physical file a plugin name
resolves to. These **flag the affected rows as drifted** and offer a re-read of those plugins.
They never trigger a session reload — silently re-reading a file underneath staged edits is the one
operation this design refuses.

**Loading is progressive and states its own incompleteness.** A plugin's records are browsable the
moment that plugin is indexed, but conflict information is not correct until the final winner sweep.
Both facts are surfaced: rows gain chevrons as they land, and the view carries an explicit
"conflict information not yet computed" message until the sweep completes. An absent conflict badge
must never be mistakable for "no conflict".

### View layout

Mods, Plugins and Downloads are visible always. Pending Changes is gated on
`modbench.hasPendingChanges` rather than on a view mode, and is renamed **"Plugins - Pending
Changes"**; Referenced By becomes **"Plugins - Referenced By"**. VS Code has no view nesting or
grouping within a container, so a title convention is the only available way to say that a view is
a sub-functionality of another. Pending Changes is **not** nested inside the Plugins tree —
ADR-0029 makes it ChangeGroup-organised precisely because it is a different projection.

### The bounded-context boundary

The merged provider is a thin composite at the composition root. **Mod Management owns the rows**
(identity, order, checkbox, origin, drift); **`PluginRepository` owns the children** (record types,
records, conflicts, spatial navigation). Neither imports the other's vocabulary, and the composite
is not a third module that knows both. ADR-0027's conflation objection is met structurally, not by
assertion.

## Considered options

**Keep two views, stop hiding the loadout during editing** — rejected as a destination, though it
is a valid first step. It leaves two views named "Plugins", now co-visible, which forces a rename
that the merge would immediately undo.

**Master/detail: a Plugin List plus a record browser scoped by its selection** — rejected. It
separates the contexts cleanly and composes with
[#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62), but xEdit navigates plugin → record
in one tree and every user arrives fluent in that ([ADR-0034](0034-xedit-is-the-ux-reference-for-the-record-editor.md),
[ADR-0019](0019-xedit-unified-tree-model-for-compare-grid.md)). Two panes is a real divergence with
no platform limitation forcing it.

**Index every plugin file on disk eagerly** — rejected. There is no session cache
([ADR-0001](0001-delete-session-cache-use-incremental-indexing.md), in-memory DuckDB), so the cost
would be paid in full on every launch, and the population is unbounded. Deferred to whenever
caching exists; the eager/lazy rule above does not change if it does.

**Index only enabled plugins, as today** — rejected. It makes enabling a plugin an indexing stall
rather than a SQL update, which forfeits the live-mutation behaviour that is the point of the merge.

## Consequences

- **Three of #241's six recorded conflicts dissolve.** Index invalidation on enable (there is
  nothing to add — the plugin is already indexed), reload-destroys-staged-work (no gesture reloads),
  and row-set disagreement (both row sets are now `plugins.txt`).
- **A participation predicate is required** in `UpdateWinners()` and in `ConflictClassifier`'s
  load-order-index comparison. This is new work and it is the correctness centre of the design.
- **`viewMode` and its context key retire**, and with them
  [#109](https://github.com/WhiskyTangoFawks/ModBench/issues/109)'s runtime view-title swap.
- **[#97](https://github.com/WhiskyTangoFawks/ModBench/issues/97)** (change Plugin load order while
  in mEdit) is delivered by this ADR rather than tracked separately.
- **Startup cost grows** — the eager set gains every disabled entry. This puts real pressure on
  [#113](https://github.com/WhiskyTangoFawks/ModBench/issues/113) /
  [#91](https://github.com/WhiskyTangoFawks/ModBench/issues/91) and on ADR-0001's no-cache position.
  Neither is changed here; both get more urgent.
- **Specs to rewrite:** `docs/specs/plugins.md` and `docs/specs/medit-plugins-tree.md` merge into
  one surface spec; `medit.md`, `medit-pending-changes-tree.md` and `medit-referenced-by.md` lose
  their view-mode framing.
- **Glossary:** `CONTEXT.md` / `CONTEXT-MAP.md` name the three narrowing axes explicitly
  (plugin-name filter, record filter, non-participating visibility) so a fourth term does not get
  invented. "Focus" is deliberately **not** a term — it was considered and dropped for having no
  referent in the domain.
