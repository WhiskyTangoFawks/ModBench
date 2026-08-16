# Plugins — Surface Specification

**Status: Implemented.** This spec merges the former Mod-Management "Plugins (Load Order)" spec
and the former Editing-context "mEdit Plugins tree" spec into one, following
[#273](https://github.com/WhiskyTangoFawks/ModBench/issues/273) retiring the second Plugins view
([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md)). There is **one** Plugins
tree (`modbench.pluginListTree`). Its shape was confirmed in a `/grill-with-docs` session
(2026-07-10, pre-merge); the merge itself was designed in ADR-0035 and built in
[#270](https://github.com/WhiskyTangoFawks/ModBench/issues/270).

**Two bounded contexts, one view, structurally.** Mod Management owns the rows — identity, Plugin
load order, checkbox — operating on physical plugin files (`.esm`/`.esp`/`.esl`) and
`plugins.txt`, never on records or FormKeys. The Editing context owns a row's children — record
types, records, the spatial worldspace/cell hierarchy — whenever a backend session is running.
Neither side imports the other's vocabulary
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), each context's own `CONTEXT.md`); the join is a thin
composite at the composition root (`PluginsTreeComposite`, `modbench/src/extension.ts`), not a
change to either provider. This structural split is what let ADR-0035 overturn ADR-0027's original
objection to merging these views: the merge is not a conflation of contexts, it is a shared row
with an owner per axis.

**Vocabulary note:** "load order" is ambiguous across Modbench's two contexts and this spec
uses the disambiguated terms throughout — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md) and each
context's `CONTEXT.md`:

- **Mod load order** — `modlist.txt` order (the **Modlist**, owned by the Mods tree); later
  position wins **file** conflicts.
- **Plugin load order** — `plugins.txt` order (owned by this surface); later position wins
  **record-override** conflicts (an Editing-context concern this surface's artifact feeds).

## Purpose

Reconstruct MO2's Plugins tab — view and manage `plugins.txt` (the Plugin load order) as a
first-class, always-available part of the Loadout workflow: enable/disable, drag-and-drop
reorder, missing-master detection — **and**, whenever a backend session is running, be the entry
point for all per-record navigation in the mEdit view: browsing each plugin's records by type,
spatially by worldspace and cell, and narrowing by name or by a SQL record filter. In xEdit these
are one tree; this surface is Modbench's answer to the same design
([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)).

## Placement ([ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md), [ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

A sidebar `TreeView` (`modbench.pluginListTree`, "Plugins"), stacked below the Mods tree in the
`modbench` view container, **always visible, unconditionally** — not a switchable tab, no view
mode, no gate of any kind. **With no backend session the rows are leaves** and this surface
behaves exactly as the Mod-Management Plugin List always has; starting a session makes rows
collapsible, which is the whole of the "editing is available now" signal (see Row children
below). Reuses the `TreeDragAndDropController` pattern already built for the Mods tree
([mods.md](mods.md) §UI — Mods tree) for reorder.

Freely relocatable by the user (e.g. to the auxiliary bar, to reconstruct MO2's literal
side-by-side layout) via VS Code's native "Move View" — but never defaults there, per
ADR-0027's auxiliary-bar convention.

## Problem Statement

Modbench already reads and writes `plugins.txt` internally — `explicitSession.ts` derives the
Editing session's Plugin load order from it — but nothing lets a user *see or manage* it. A
plugin whose master loads after it will CTD the game with no warning in Modbench; today the
only way to inspect or fix `plugins.txt` is MO2's own Plugins tab or a hand edit.

Once a session is running, a mod author also needs to find a record before they can do anything
with it — and "find" means several different questions. Which plugins are loaded? What does
*this* plugin actually declare, as opposed to what wins? Where does a record sit in the world?
Which records have I already touched? An author who has to leave the tree to answer any of these
has lost the thread of what they were doing — and the loadout is too big to page through, so any
surface that only lists things, with no way to narrow by name or by condition, is unusable at the
scale it must work at.

## Solution

A **Plugins** sidebar tree — one row per `plugins.txt` line, in Plugin load order — with a
checkbox (enable/disable), drag-and-drop reorder (single- or multi-row), an order-aware
missing-master badge, a name filter, and a Reveal-in-Explorer row action. It mirrors MO2's
Plugins tab closely enough to alternate between the two on the same instance, with no backend
required.

Whenever a backend session is running, every row also expands into that plugin's records — by
type, spatially by worldspace and cell — narrowing on two independent axes: the row-level name
filter above, and a SQL record filter scoped to a row's children. Every path through the
record-browsing side ends at the [Record editor panel](medit-record-editor.md).

The session is constructed on entry from every line of the active profile's `plugins.txt` —
disabled entries included, carrying their participation (#270 / ADR-0035) — plus vanilla masters;
there is no separate load-session step.

## User Stories

### Plugin load order (Mod Management, no backend required)

1. As a user, I want a Plugins list showing every entry in `plugins.txt`, in Plugin load
   order, so that I can see what the game will actually load and in what sequence.
2. As a user, I want each plugin shown as a single row, so that the list maps one-to-one to
   `plugins.txt`'s lines — no separate row for a same-named plugin another mod also ships;
   `plugins.txt` itself only ever has one line per plugin name, so there's nothing to dedupe.
3. As a user, I want vanilla, DLC, and Creation Club plugins listed alongside mod-provided
   ones, so that I see the whole Plugin load order the game will actually load, not just the
   subset that came from an installed mod.
4. As a user, I want a checkbox on each row that enables/disables the plugin, writing
   `plugins.txt` immediately, so that toggling a plugin works the same way every other
   mutation in this bounded context does — no separate save step.
5. As a user, I want to be able to toggle a vanilla/DLC/CC plugin's checkbox the same as any
   other row, so that Modbench doesn't invent a restriction MO2 itself doesn't have.
6. As a user, I want a missing-master badge on a plugin whose master isn't loaded *before* it
   — whether the master is absent entirely or just sequenced too late — so that I catch the
   actual CTD-causing condition, not just "is the master present somewhere."
7. As a user, I want that badge's message to make clear it's checking order, not just
   presence, so that I understand why it can disagree with the Mods tree's own (presence-only,
   mod-granularity) missing-master badge on the same plugin — and, once a session is running and
   a richer session-derived verdict exists for the same master, I want the two merged into one
   badge rather than shown as a second decoration that might contradict the first (see Missing-
   master badge (order-aware) and session-derived master/load-failure decoration).
8. As a user, I want to drag a plugin to a new position and have `plugins.txt` reordered
   immediately, so that fixing a load-order problem is a direct manipulation, not a form.
9. As a user, I want to ctrl/shift-click to select multiple plugins and drag them together as
   a block, so that reordering a cluster of related plugins doesn't take one drag per plugin.
10. As a user, I want a filter that narrows the list to plugins whose filename matches
    what I type, so that I can find one without scrolling a 100+-entry load order.
11. As a user, I want one Refresh, in one place, that re-reads every list at once if any of
    them looks stale (e.g. after an external MO2 edit), so that I never have to remember
    which tree owns which refresh (#247 — it lives on the
    [Loadout header](loadout-header.md)).
12. As a user, I want to right-click a plugin and Reveal it in my OS file manager, so that I
    can go inspect the actual file behind a badge without hunting for it myself.
13. As a user, I want this list visible at all times, with no separate open/launch step, so
    that it behaves like the Mods tree it's stacked with, not like the occasional-use
    Downloads tab.
14. As a user, I want a clear error state if `plugins.txt` can't be read, so that a corrupt or
    missing file doesn't just silently show an empty list.

### Record navigation (Editing, once a backend session is running)

15. As a user, I want to expand a plugin row and see its record types, then its records
    (paginated, with a "Load more…" step), so that browsing a large plugin stays responsive.
16. As a user, I want each record labeled with its EditorID and FormKey (or just the FormKey
    when it has no EditorID), so that I can recognize records the way I do in xEdit.
17. As a user, I want to select multiple tree nodes with Ctrl/Shift-click and run a batch
    action (e.g. Remove Record) across the whole selection, so that I can act on many records
    at once, even across different plugins.
18. As a user, I want to browse a plugin's worldspaces and interior cells spatially — down
    through blocks, sub-blocks, cells, and their persistent/temporary placed references — so
    that I can navigate the world the way it's actually laid out, seeing only what *that*
    plugin declares rather than a cross-plugin winner.
19. As a user, I want to open a record by single-clicking its node, so that inspecting a record
    is immediate.
20. As a user, I want to filter the record tree by a SQL query against the backend's per-type
    tables (returning `form_key`), pruning record types and records with no matches — but
    never a plugin row itself, since that would make the load order unviewable and
    unreorderable mid-patch (ADR-0035 amends ADR-0018 on this point) — so that I can slice the
    loadout by any condition I can express without a fixed toggle UI.
21. As a user, I want to save filters as `.sql` files, apply one from a picker or from an
    inline Code Lens on the file, and see which filter is active, so that my useful queries are
    reusable and obvious.
22. As a user, I want a built-in "pending changes" filter preset, so that I can immediately
    narrow the tree to records I've touched — this, not the Pending Changes tree, is how I
    browse my staged edits in context.
23. As a user, I want to create a new plugin, add a record to a plugin, copy a record as an
    override or as a new record into another plugin, and remove records (with a confirmation
    that lists everything selected), so that the common authoring operations are all in the
    tree.
24. As a user, I want to open a plugin's header as a first-class record by clicking the plugin
    node — viewing its author, masters, and flags in a single-column panel, and (on editable
    plugins) editing them through pending changes: set the author, toggle ESL/ESM (rejected at
    stage time when the plugin isn't ESL-eligible), and add a master chosen from the loaded
    plugins (validated so I can't make the plugin unloadable) — so that maintaining a plugin's
    header is staged and reviewable like any other edit.
25. As a user, I want to create and manage placed references (REFR/ACHR) inside a cell's
    persistent or temporary group, so that I can edit world placement spatially.
26. As a user, I want a plugin whose master can't be resolved flagged and still fully browsable —
    never deactivated, excluded or hidden — with the tooltip telling me whether the master is
    missing entirely or is present but itself failed to load, so that I can inspect and fix the
    problem instead of losing the plugin from the tree. If a plugin fails to open or parse
    outright, I want its row to stay and show me why, rather than the load silently continuing
    without it (#277 / [ADR-0037](../adr/0037-unresolvable-masters-are-indexed-and-flagged.md)).

## Implementation Decisions

### Scope

- This spec covers the whole merged surface: the sidebar tree, checkbox, drag reorder, the
  order-aware missing-master badge, the name filter, Refresh, Reveal-in-Explorer, and —
  whenever a session is running — record browsing, the spatial hierarchy, the SQL record
  filter, record-authoring commands, and the session-derived master-issue and load-failure
  decorations (#277 / ADR-0037).
- **Auto-sort** (dependency-aware topological sort, LOOT parity) is **out of scope, deferred
  indefinitely** — a possible future initiative of its own, not scheduled. See Out of Scope.
- **Cross-highlight with the Mods tree** (selecting a plugin highlights its providing mod(s)
  and vice versa, MO2 parity) is **deferred** to
  [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62) — blocked by a real VS Code
  API limitation, not a priority call. See Out of Scope.
- **No "Mod" column.** Which mod provides a plugin is surfaced only via the (deferred)
  cross-highlight, matching MO2's own implicit-link design — see #62.

### Row model (Mod Management)

- **One row per non-comment, non-blank `plugins.txt` line**, in file order — top of the list
  loads first, bottom loads last and wins record-level overrides (same last-wins polarity as
  the Mods tree's `modlist.txt`, just a physically different file and a different conflict
  axis — see the Vocabulary note above).
- No dedup step at render time: the row set **is** `plugins.txt`'s line set. Winner resolution
  between same-named plugins from different mods is a Mod-Management concern the row model
  doesn't compute or care about — it only manages the sequence of names.
- Checkbox reflects the line's `*` prefix (MO2's own enabled marker).
- **The leading slot answers exactly one question — "can you change whether this loads?"**
  ([#276](https://github.com/WhiskyTangoFawks/ModBench/issues/276), [ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md)):
  a checkbox on a togglable `plugins.txt` line (`contextValue: "plugin"`); a lock icon on an
  implicit master (`contextValue: "pluginImplicit"`, discovered from the game's Data folder rather
  than a `plugins.txt` line) — forced on, neither toggled nor dragged; nothing at all on a row that
  stands for no plugin file in the load order at all (today only the sentinel error/empty rows —
  [#34](https://github.com/WhiskyTangoFawks/ModBench/issues/34)'s non-participating rows don't
  exist yet). This resolves the contradiction this spec's pre-merge self and the pre-merge Editing
  tree spec had — no lock because it misrepresented toggleability, vs. a lock for read-only-ness —
  by giving the lock one meaning: it is never about record editability, only about this row's own
  toggle/drag facts, which Mod Management already owns without needing the Editing session.
  Read-only-for-editing is a separate fact and is never an icon on this tree, on any row kind — see
  Record navigation below.
- **MO2 itself doesn't render this as a lock.** `pluginlist.cpp`'s `forceLoaded` row (its own
  equivalent of an implicit master) is a *checked, disabled* checkbox with grayed name text and a
  tooltip — never a distinct icon. That pattern isn't reproducible here: `TreeItemCheckboxState`
  is `Checked`/`Unchecked` only, with no non-interactive variant, so a rendered VS Code checkbox is
  always clickable — a checked-but-forced-on row would invite a toggle the extension would have to
  silently revert. The lock is the platform-forced substitute for the icon only; everything else
  about MO2's presentation carries over unchanged: the row's label is grayed
  (`ImplicitMasterDecorationProvider`, the same `resourceUri` + `FileDecorationProvider` pattern as
  the Downloads tree's hidden-row dimming), it stays undraggable, and the tooltip uses MO2's own
  wording ("This plugin can't be disabled or moved (enforced by the game)."), not invented copy.
- **Read-only-for-editing** (Editing's "Immutable plugin", `PluginMetadata.isImmutable`) is decided
  and rendered by `PluginsTreeComposite` — the one place already allowed to know both bounded
  contexts — once a session reports it, as a tooltip appended to whatever tooltip the row already
  carries (e.g. the missing-master badge below). It is never a `contextValue`: no per-row editing
  command exists yet to gate off one, and adding that plumbing before a command needs it would be
  exactly the speculative scaffolding this project's conventions rule out. **Open Header stays
  reachable on an immutable plugin, ungated** — viewing a plugin's header is not an editing action,
  only the fields inside it are (see Record navigation below); an immutable plugin's row otherwise
  has no editing action to hide today, since none is contributed on a plugin row yet.

### Row children ([#270](https://github.com/WhiskyTangoFawks/ModBench/issues/270), [ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

- **With no editing session every row is a leaf** and nothing on the Mod-Management side of this
  surface changes. Starting a session makes rows collapsible; **chevrons appearing across the
  tree are the whole "editing is available now" signal** — there is no banner and no mode.
  Closing the session returns every row to a leaf. Neither transition re-reads `plugins.txt`, so
  the load order, the name filter, row expansion and scroll position all survive it.
- **Expanding a row browses that plugin's records** — record types, the spatial
  worldspace/interior-cell hierarchy, and paginated record nodes (see Record navigation below).
- **A row expands only if the session actually holds its plugin.** A row whose plugin is not in
  the session stays a leaf rather than opening onto an empty list, which would read as "this
  plugin has no records" (ADR-0026).
- **Disabled plugins expand and browse like any other.** The session indexes every `plugins.txt`
  line, enabled or disabled; the `*` prefix is *participation* — whether the plugin competes for
  winner — not whether it is loaded. A disabled plugin can never be the winning record for a
  FormKey and never takes part in conflict classification.
- **Not yet built.** ADR-0035 also describes lazily indexing a plugin file `plugins.txt` never
  names (never-listed, or a copy shadowed by a higher-priority mod) on demand, behind a
  non-participating-visibility toggle. No such toggle is contributed anywhere in `package.json`
  and `PluginListProvider` reads only `plugins.txt`'s own line set — this is the ADR's design for
  that case, not current behavior.
- **The seam is a thin composite at the composition root** (`PluginsTreeComposite`), not a change
  to either provider: Mod Management owns the rows, the record browser owns the children, and
  neither imports the other's vocabulary — enforced by `src/test/contextBoundary.test.ts`, not by
  review. A drop onto a child row is refused rather than treated as "past the last row", which
  would silently move the dragged plugins to the end of the load order.

### Record navigation (Editing, once a session is running)

- **Plugin nodes** (`contextValue: "plugin"`, or `"pluginImplicit"` for an implicitly-loaded
  vanilla/DLC master not named in `plugins.txt` — see Row model above; read-only-for-editing is a
  tooltip `PluginsTreeComposite` appends, never a third `contextValue`, per Row model above). An
  **Open Header** action (context menu; also available inline) opens the
  plugin's **header record** — author, masters, flags — as a single-column record panel. A
  plugin's context menu also exposes New Plugin…, Copy as Override Into…, and — on editable
  plugins only — Add New Record…, Convert to ESL/ESM, Add Master…, and Run Script…. Each is a
  confirmation or picker as appropriate; destructive ones confirm.
- **Record-type nodes** (`contextValue: "recordType"`): labeled by the type's **human-readable
  name** (e.g. "Activator" for `ACTI`, "Game Setting" for `GMST`), matching xEdit's naming from
  `wbDefinitionsFO4.pas` (#110); the raw 4-char signature remains the internal identifier (cache
  keys, `contextValue`, commands, API `type`). Children are paginated record nodes with a
  "Load more…" node at the end of a page.
- **Record nodes** (`contextValue: "record"`, or `"recordImmutable"` for a row whose plugin is
  read-only for editing — an immutable plugin or a shadowed copy — which keeps the copy family
  but hides Remove, matching the column header's `!immutable` gate; #281): labeled
  `{EditorID}  [{RecordType}:{FormID}]` (FormKey only when no EditorID). Single-click (or Open
  Record) opens the editor; the context menu adds Copy as Override Into…, Copy as New Record
  Into…, Remove (a confirmation listing every selected record, deleting the whole selection as
  one batch; the Delete key also triggers it), and Run Script… (context = this record). #281:
  the row carries its own copy identity (plugin + origin), and the copy commands act on *that*
  version — never silently the winner — the same #202 rule the column header follows; the three
  entries are the same command ids, in the same xEdit order, on the record row, the placed row
  and the record editor's column header (enforced by `packageJson.test.ts`). Removing a record
  that is itself a **pending create** reverts that create's whole ChangeGroup (component-revert,
  ADR-0028) instead of staging a `delete` on top of it — a record with no on-disk existence has
  nothing to delete. A mixed batch reverts the pending-create targets and stages a `delete` for
  the committed ones; the response reports the two outcomes distinctly (`revertedFormKeys` vs.
  `stagedGroup`) rather than collapsing them (#143).
- Context menu availability is driven by node `contextValue`, sourced from whichever side of
  the composite built the row: Mod Management for plugin rows (`"plugin"`, `"pluginImplicit"`),
  the record browser for everything a row expands into (`"recordType"`, `"record"` /
  `"recordImmutable"`, `"refr"` / `"refrImmutable"`, and the spatial contextValues below).

### Record filter (SQL)

- The record tree is filtered by a **filter file** — a plain `.sql` file containing a DuckDB
  `SELECT` returning `form_key`. While active, record types and records with no matching
  records are pruned. **A plugin row is never hidden by this filter** — it stays visible and
  simply does not expand, since this tree is also the load order and hiding a plugin would make
  it unviewable and unreorderable mid-patch (ADR-0035 amends
  [ADR-0018](../adr/0018-sql-file-based-record-filter.md) on this point).
- Entry points: a title-bar funnel (opens a `setFilter` quick pick of `.sql` files in
  `modbench.scriptsPath` plus "New filter…"), a funnel-slash to clear (shown only while a
  filter is active), command-palette equivalents, and **Code Lens** on open `.sql` files under
  `modbench.scriptsPath` ("▶ Apply as Filter" when the file differs from the active filter; "✓
  Active — click to clear" when it is the active filter). A `filterActive` context key drives
  the active indicators.
- If reading the active-filter state fails (backend error), the sync degrades to *inactive* and
  warns the user rather than silently presenting the unfiltered tree as a confirmed "no filter"
  ([ADR-0026](../adr/0026-error-surfacing-policy.md); same degrade-and-warn convention as other
  secondary reads). The failure is non-fatal to session activation.
- Conflict-status filtering, EditorID search, and record-type narrowing are all expressed as
  user-written SQL against the per-type DuckDB tables — **no structured toggle UI**. A built-in
  `pending-changes.sql` preset (`SELECT DISTINCT form_key FROM pending_changes`) is copied into
  `modbench.scriptsPath` on first use. That preset is how staged edits are browsed by plugin
  and record; the [Pending Changes tree](medit-pending-changes-tree.md) is organized by
  ChangeGroup and deliberately does not duplicate it (ADR-0029).
- **Not yet built.** ADR-0035 proposes narrowing to a single plugin for authoring as `Apply
  Filter to Selected`, adopted from xEdit's `mniNavFilterApplySelected` — the ordinary record
  filter invoked against the tree selection, not a mode, introducing no new term. No such
  command is contributed anywhere in `package.json` today.

### Worldspace / interior-cell tree

- **Per-plugin**, under each plugin node: "Worldspaces" and "cell - Interior" group nodes show
  what *that plugin* declares (records and overrides), never a cross-plugin winner. Placed
  records (REFR/ACHR) are indexed; parentage lives in `placement` / `cell_location` side tables
  ([ADR-0023](../adr/0023-placed-objects-indexed-with-placement-side-tables.md)).
- The spatial hierarchy descends Worldspace → Block → Sub-block → Cell (by XCLC coordinates) →
  Persistent/Temporary placed-reference groups → placed references. Block and Sub-block nodes
  are grouping-only (no record, no click); clicking a CELL or REFR node opens the editor.
- Context menus: a **placed group** offers Create Placed… (quick pick REFR/ACHR + optional
  template FormKey); a **placed reference** (`contextValue: "refr"` / `"refrImmutable"`) offers
  the same record trio as a record row — Copy as Override Into…, Copy as New Record Into…,
  Remove — with the same handlers and immutable gating (#281; a copied-as-new placed record
  lands under the template's own cell and Persistent/Temporary group). CELL nodes have no menu.

### Missing-master badge (order-aware) and session-derived master/load-failure decoration

Two independent signals can land on the same plugin row, from two different sources, and
[ADR-0037](../adr/0037-unresolvable-masters-are-indexed-and-flagged.md) is what keeps them from
reading as disagreeing decorations.

**Order-aware (Mod Management, no session needed).** Stronger than the Mods tree's badge, and
deliberately so — this view has the one thing the Mods tree structurally lacks: an actual plugin
sequence to check order against.

- For each plugin, read its declared masters via the existing `readMasters()`
  (`masterReader.ts`, TES4 header read — already used by `statusChecker.ts`).
- Flag the plugin if any declared master is **absent from `plugins.txt` entirely**, or
  **present but positioned after this plugin's own line** — both are real CTD conditions; the
  Mods tree's badge (presence-only, mod-granularity, no order dimension) only catches the
  first.
- Badge/tooltip text names the condition explicitly (e.g. "Master `{name}` is not loaded
  before this plugin") so it reads distinctly from the Mods tree's "Missing master: {names}" —
  the two can legitimately disagree on the same plugin, and the wording should make it obvious
  why rather than looking like a bug. No ADR needed for this divergence — the modding-literate
  audience understands presence-vs-order implicitly once the badge text says so.
- Vanilla masters are ordinary rows in this list (per Row model above), so an order check
  against them works the same as for any mod-provided master — no special-casing needed.

**Session-derived (Editing, once a session is running, #277 / ADR-0037).** Presence-only, never
order-aware — Mutagen resolves a master by reading it from the plugin's own header, so it never
needs that master positioned before the plugin, only present and loadable somewhere in the
session. `GET /plugins`' `masterIssues` reports, per plugin, every one of its own declared masters
that didn't resolve, classified two ways: `DirectlyMissing` (never part of the session at all —
no `plugins.txt` line for it, or its file doesn't exist) renders "Missing master: `{name}`";
`Unloadable` (it has a line and a file, but that file itself failed to open or parse) renders
"Master `{name}` cannot be loaded". The declaring plugin is never deactivated, excluded or hidden
for this — it stays indexed, browsable, and (if enabled) participating in winner computation
exactly as it would without the flag; ADR-0037 is the deliberate, recorded divergence from
xEdit's force-deactivate-and-cascade rule. There is no cascade: a plugin whose master merely has
*its own* missing master is not itself flagged — `masterIssues` only ever describes a plugin's
own declared masters, never a transitive fact about a master's masters.

**Reconciliation (AC8): one decoration, not two that can disagree.** `PluginsTreeComposite`
combines the two signals by master name. A master both signals name is reported once, in the
session-derived wording — richer because it distinguishes directly-missing from unloadable, a
distinction the order-aware check has no way to make from a plain-text read of `plugins.txt`. A
master the order-aware check flags that the session-derived signal does *not* — present in the
session, loaded successfully, but sequenced after this plugin's own line — is preserved and
worded distinctly ("is not loaded before this plugin"), since that is a real CTD risk the
session-derived signal structurally cannot see (order doesn't affect Mutagen's own resolution).
When a session is not running, or the session-derived signal has nothing to say about a row, the
order-aware badge renders exactly as it does today, untouched.

**Neither signal, nor the reconciled decoration, nor the load-failure decoration below, ever
touches the leading slot.** The checkbox/lock position is reserved for exactly one question —
"can you change whether this loads?" (#276, see Row model above) — and every decoration in this
section is icon, description and tooltip only.

**Load-failure decoration (#277 / ADR-0037 AC7).** A plugin that fails to open or parse is
skipped so the rest of the load order still loads (`GameSession.LoadFailures`), but its row is
never dropped — Mod Management builds rows from `plugins.txt`, not from which plugins the session
managed to index, so the row was already there. `PluginsTreeComposite` decorates it with its
recorded failure reason ("Failed to load: `{reason}`") the same way it decorates a master issue;
the row stays a leaf, since a plugin that never indexed has nothing to expand into. The existing
session-load toast (`SessionController.loadExplicitSession`, one aggregated warning per load) is
unchanged and is not duplicated by this decoration — the same failures reach both, from the same
response, so there is exactly one notification and one persistent, per-row explanation of why.

### Pending-change decoration ([#331](https://github.com/WhiskyTangoFawks/ModBench/issues/331))

Any row (plugin or record) that carries a staged pending change is decorated with the same
git-style vocabulary VS Code users already read from the Explorer's own SCM decorations: a badge
plus a theme color, via `vscode.FileDecorationProvider` (`medit/PendingChangeDecorationProvider.ts`)
— never a bespoke badge mechanism.

- **Record row** (`RecordNode`, and every other formKey-addressable node in the spatial hierarchy
  — `WorldspaceNode`, `CellNode`, `PlacedNode`): a staged field edit, delete or renumber renders
  the **'modified'** treatment (badge `M`, `gitDecoration.modifiedResourceForeground`). A staged
  **creation** (today: a record staged via the create change type; #288 will add staged plugin
  creation as a consumer of this same language) renders the **'added'** treatment instead (badge
  `A`, `gitDecoration.addedResourceForeground`) — distinct from 'modified', matching git's own
  treatment of a new file. Every node type that can carry a pending change gets this — an
  undecorated row must never be mistakable for "no pending changes" once decoration exists at all.
- **Plugin row**: 'modified' whenever *any* contained record carries a staged change, uniformly —
  even when the only staged content is a creation. 'added' is reserved for the thing that is
  itself new (matching git: a folder holding a new file still reads as modified, not added); once
  #288 makes a *plugin* the pending-created thing, plugin-level 'added' becomes correct there.
- **Implicit/forced-master plugin rows are out of scope.** `ImplicitMasterNode`
  (`modmanager/PluginListProvider.ts`) already sets its own `resourceUri` — a real
  `Data/<name>` filesystem path consumed exclusively by `ImplicitMasterDecorationProvider` to gray
  a forced-loaded master's label (#276) — and a `TreeItem.resourceUri` is single-valued, so
  assigning a second one for pending-change purposes would silently break that unrelated
  decoration. `PluginsTreeComposite` enforces this structurally (never overwrites a resourceUri a
  row provider already set), not by naming "implicit master" — the records a vanilla/DLC/CC master
  contains still decorate individually, through their own `RecordNode` scheme; only the plugin
  row's own badge is affected.
- A shadowed copy's row (ADR-0036: two loaded copies sharing a filename) never decorates, even
  when the winning copy of the same file has a staged change on the same FormKey — only the
  winning copy is ever staged against (the backend always resolves the current winning origin
  server-side), so a shadowed row's identity URI carries its `origin` specifically so the
  derivation can refuse to decorate it.
- Event-driven, not polled: refreshed from the same points that already tell the extension host
  "pending state changed" — the webview's `PENDING_CHANGED` message and every `SessionController`
  mutation (stage, copy, create, delete, save, revert). No new endpoint; the provider performs its
  own `GET /changes` read rather than sharing the Pending Changes tree's (that one only fetches
  while its own view is visible).

### Selection & drag

- `canSelectMany: true`, shared across both plugin rows and expanded record nodes — batch-capable
  context commands (currently Remove) receive the full selection.
- Drag-and-drop reorders the current plugin-row selection (single or multi, contiguous or not)
  as a block, moving all selected rows to the drop index while preserving their relative order —
  same `TreeDragAndDropController` mechanics already built for the Mods tree's separator-block
  drag, applied to an arbitrary row selection instead of a separator's contiguous children.
- Writes `plugins.txt` immediately on drop — no save/discard step, matching every other
  mutation in this bounded context.

### Toolbar / title bar

Fixed slot order (`modbench/CLAUDE.md` rule 5): name filter, then the view's state affordance
(here, the record filter — a second, independent narrowing axis), then domain actions, then
overflow, then native **Collapse All** last.

- **Slot 1 — name filter**: the shared Modbench filter widget (`registerFilterBoxCommand`, a
  transient `InputBox`), live-narrowing plugin rows by case-insensitive substring match against
  filename; dismissing the box (`onDidHide`) restores the full list. One widget spans every
  Modbench list surface: Mods, Downloads, and here (#247). It is a **distinct axis** from the
  record filter: this narrows *which plugin rows* appear; the record filter narrows *which
  records* appear under an expanded row. The two compose, and their icons say which is which —
  `$(search)` narrows by name, `$(filter)` narrows by condition.
- **Slot 2 — record filter and its Clear** — the SQL record filter described above; a no-op
  with no session running (there is nothing to filter yet).
- **Slot 3 — New Plugin…**.
- **Native Collapse All** — this became the deepest tree in the product once #270 merged it
  (plugin → record type → record), so it earns the affordance the pre-merge Editing tree
  already had.
- **No Refresh of its own** (#247). Re-reading `plugins.txt` is part of the single
  workspace-scope Refresh on the [Loadout header](loadout-header.md), which re-reads every
  Mod-Management source together; re-reading a *session* (which can disturb staged work) is the
  header's separate, explicitly-named Reload Session command.

### Row context menu

- **Reveal in Explorer** (plugin rows) — resolves the plugin name to its physical path (same
  winner resolution `explicitSession.ts` already performs via `FileConflictIndex`, falling back
  to the game's `Data/` folder for an unmanaged vanilla/DLC/CC plugin) and reveals it in the OS
  file manager. Same primitive as the Mods tree's existing "Open in Explorer"
  (`revealFileInOS`).
- Record-scope context menu entries (Copy as Override Into…, Copy as New Record Into…, Remove,
  Create Placed…) are described under Record navigation above — they apply to this tree's
  expanded rows the same way regardless of which side of the composite built the row above them.

### Write mechanism

- A pure `pluginsText.ts`, templated directly on `modlistText.ts`'s byte-faithful
  splice-transform pattern: parse `plugins.txt` into an ordered model view, mutate via surgical
  splice (`lineRanges`, `mo2/lineScan.ts`) — never model→re-serialization — so comments, blank
  lines, and CRLF/BOM survive untouched.
- `IModlistSource` gains the write-side counterparts to its read-only `readPluginOrder()`/
  `readEnabledPlugins()`: toggle a line's `*` prefix, and reorder lines — mirroring the shape of
  the existing `modlist.txt` mutators (`moveModToSeparator`, `reorderSeparatorBlock`).
- **Current mutation path**: reorder, enable and disable apply immediately and unprompted via
  the surgical splice write above — a direct `plugins.txt` edit, nothing else. `PluginListProvider`
  makes no backend call to do this (root `CLAUDE.md`: Mod Management never calls the C# backend),
  so there is no session reload and no server round trip to wait on.
- **Not yet built.** ADR-0035 describes a *different*, backend-driven mutation model for later —
  reorder/enable/disable as a SQL `UPDATE` of `load_order_idx`/the participation flag plus a
  winner re-sweep, with a view-header progress indicator as the only feedback, once the
  participation predicate lands (#97/#279). None of that exists yet: no code path calls the
  backend for a Plugin load order mutation, and no progress indicator is wired to the checkbox or
  the drag handler. Stated here as the destination, not as current behavior.

### Entry point

- No open/launch command. The tree is simply always present — identical in spirit to the Mods
  tree itself, unlike Downloads' editor-tab-on-demand model — through a session as well as
  outside one.

### Empty / error states

- **Read failure** (missing/corrupt `plugins.txt`) — a single error tree node, per the existing
  `modmanager/CLAUDE.md` convention ("show an error tree node instead of an empty list when a
  fetch/read fails"), warning surfaced via the injected reporter per
  [ADR-0026](../adr/0026-error-surfacing-policy.md).
- **Empty `plugins.txt`** (no lines) — realistically near-unreachable (vanilla masters always
  populate it) but handled for completeness: a single informational node, "No plugins," mirroring
  the Pending Changes tree's empty state (`medit-pending-changes-tree.md`).
- Per `modbench/CLAUDE.md`: this holds for **load-more (pagination) fetches** on the
  record-browsing side too — a failed "Load more…" surfaces an error node for that parent while
  keeping the already-loaded pages and the retry affordance, and the error clears on a
  successful retry.

### Architecture / seams

- **Primary Mod-Management seam**: `pluginsText.ts` (parse + mutate), pure, Vitest-tested, no
  `vscode` import — same seam class as `modlistText.ts`/`metaIni.ts`/`downloads.ts`.
- **Missing-master order-check**: a pure function taking (a plugin's declared masters via
  `readMasters()`, the ordered plugin-name list, that plugin's own index) → a verdict. Lives
  alongside or extends `statusChecker.ts`.
- **Session-derived master classification** (#277 / ADR-0037): `MasterResolution.Classify`
  (`MEditService.Core/Queries/`), a pure function over data the session already has
  (`GameSession.Plugins`, `GameSession.LoadFailures`) — no Mutagen re-read. Consulted once per
  `GET /plugins` call and reported on `PluginResponse.MasterIssues`; distinguishes `DirectlyMissing`
  from `Unloadable` and never cascades (only a plugin's own `Masters` list is consulted).
- **`PluginListProvider`** (`TreeDataProvider`, `modmanager/`): rows only, a
  `TreeDragAndDropController` reusing the Mods tree's established controller shape, and the row
  side of the Filter `InputBox` — none of this layer holds record-browsing logic. Exposes
  `orderIssueMastersOf(node)` (#277 AC8) so the composite can read the order-aware badge's flagged
  master names structurally, without parsing rendered tooltip text.
- **`PluginTreeProvider`** (`medit/`): a row's children — record types, records, spatial
  hierarchy — unchanged in ownership by the merge; its `getPluginChildren(name)` is the public
  entry point a row built elsewhere (by `PluginListProvider`) expands into, and it is unit-tested
  without VS Code (`PluginRepository`, not `ApiClient`).
- **`PluginsTreeComposite`** (`modbench/src/`, composition root): joins the two above and does
  nothing else. Imports from neither bounded context; its whole knowledge of both domains is
  `pluginFileOf`, the boundary object `CONTEXT-MAP.md` already names. Enforced by
  `src/test/contextBoundary.test.ts`, not by review. `setSession` (#276/#277) also carries
  `readOnlyFiles`, `masterIssues` and `loadFailures` — one hand-off, not several, since all of it
  comes off the same session and changes together; the composite decorates icon/description/
  tooltip only, never the leading slot.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — same standard as every
  other surface spec in this directory: given `plugins.txt` text + a mutation, assert the
  resulting text; given a plugin's masters + the ordered plugin list, assert the verdict; given a
  session, assert the rendered node shape, labels, `contextValue`s, and pagination through
  `getChildren`/`getTreeItem` against a stubbed repository. Never construct nodes directly.
- **Primary unit seam — `pluginsText.ts`** (Vitest, `npm run test:unit`, no backend):
  - parse: line → row mapping, comments/blanks ignored but preserved on write.
  - toggle: `*` prefix set/cleared, byte-faithful (CRLF/BOM/comments untouched).
  - reorder: single-row and multi-row (contiguous and non-contiguous selection) moves,
    byte-faithful.
- **Missing-master order-check unit tests**: master present-and-before → ok; master
  present-but-after → flagged; master absent → flagged; vanilla master present-and-before → ok
  (no special-casing needed, per Row model).
- **Session-derived master classification unit tests** (`MEditService.Tests/Query/MasterResolutionTests.cs`):
  master absent from both the loaded and failed sets → `DirectlyMissing`; master present in the
  failed set → `Unloadable`; master successfully loaded → no issue; a plugin whose master's own
  master is missing is not itself flagged (no cascade). The composite's reconciliation of this
  with the order-aware badge, and its load-failure decoration, are covered by
  `src/test/PluginsTreeComposite.test.ts` and `src/test/integration/extension.test.ts` — including
  a case where the wire response omits `masterIssues` entirely, asserting the row renders
  undecorated rather than throwing.
- **Record-browsing unit seam**: `PluginTreeProvider` takes a `PluginRepository`, not an
  `ApiClient` — unit-tested without VS Code (Vitest, `npm run test:unit`). New data queries go
  on the `PluginRepository` interface and are implemented in `ApiPluginRepository`.
- **Composite seam**: `PluginsTreeComposite`'s own `getChildren`/`getTreeItem`/`setSession` —
  chevron transitions on session start/stop, expansion gated on session membership — tested
  against fake row/child providers (`src/test/PluginsTreeComposite.test.ts`), and the bounded-
  context boundary itself (`src/test/contextBoundary.test.ts`).
- **Record semantics and conflict classification** are the backend's responsibility and tested
  there (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.
- **Prior art**: `modlistText.test.ts`, `metaIni.test.ts`, `statusChecker.test.ts` — same
  fixture-in/value-out style; instance fixtures live under
  `modbench/src/modmanager/test/fixtures/`.
- **Integration seam** (`npm run test:integration`, real VS Code process): the tree renders from
  `plugins.txt` with no session; checkbox toggle, drag-reorder and the name filter round-trip
  with and without a session running; starting/stopping a session puts chevrons on and takes
  them off without disturbing the load order; navigation opens a record panel; the record filter
  prunes record types and records but never a plugin row; Reveal in Explorer dispatches; read
  failure renders the error tree node. Add new command id(s) to `EXPECTED_COMMANDS`
  (`modbench/CLAUDE.md`).

## Out of Scope

- **Auto-sort** (dependency-aware topological sort, LOOT parity) — deferred indefinitely; not
  scheduled, may become its own future initiative.
- **Cross-highlight with the Mods tree** on selection (MO2 parity) — deferred, tracked as
  [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62). Blocked by a confirmed VS Code
  API limitation (no programmatic multi-item selection, `FileDecoration` can't paint a full row
  background) rather than a priority call; #62 records the provisional approach
  (`FileDecorationProvider` color/badge tint) for whenever it's picked up.
- **A "Mod" column** or any textual plugin→mod ownership display — deliberately dropped in
  favor of the (deferred) cross-highlight, matching MO2's implicit-link design rather than
  inventing a text column MO2 itself doesn't have.
- **Guard-railing vanilla/DLC/CC masters** against being disabled — deliberately not added;
  MO2 doesn't guard-rail it either, and the order-aware missing-master badge catches the
  fallout if it happens.
- **A structured conflict/EditorID/record-type filter UI** — filtering is deliberately
  user-written SQL against the per-type tables, not a fixed toggle set (ADR-0018).
- **Multi-step form-space operations** — compact FormIDs, copy-as-underride (moving a record
  down into a master), merge-into-another-plugin, and sort/clean/remove masters — are deferred
  and will be delivered as Python scripts over the header/renumber/copy/delete staging
  primitives, not bespoke commands. They compose from those primitives and are inherently
  multi-step (a masters reorder remaps every FormID's master index; clean requires whole-plugin
  reference analysis). Near-term header editing (author, ESL/ESM flag, add master) is a
  first-class feature — see User Story 24.
- **What the record editor does with a record once opened** —
  [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- **Glossary** — `CONTEXT.md` (Editing) and
  [modmanager `CONTEXT.md`](../../modbench/src/modmanager/CONTEXT.md) distinguish **Plugin
  load order** (this surface's subject, `plugins.txt`, record-level) from **Mod load order**
  (the Modlist, `modlist.txt`, file-level) — previously conflated under one ambiguous "load
  order" term. [CONTEXT-MAP.md](../../CONTEXT-MAP.md)'s Mod-Management→Editing relationship
  description matches: the Editing session's plugin *order* comes from Plugin load order, not
  Modlist order (Modlist only resolves each plugin *name* to its winning physical file).
- **Filter box is a declared cross-surface convention**, not a per-surface bespoke choice: Mods
  tree, Downloads, and this surface all use `registerFilterBoxCommand`.
- The conflict badge on a record node (the two-axis model, [ADR-0016](../adr/0016-two-axis-conflict-model.md))
  is planned but not yet built on this tree — see [#285](https://github.com/WhiskyTangoFawks/ModBench/issues/285),
  which also tracks the missing Conflicts node; both were recorded as spec drift by #270 and
  carry over unchanged by this merge. The full visual encoding, once built, lives in
  [medit-record-editor.md](medit-record-editor.md).
- **Deferred follow-up**: [#62](https://github.com/WhiskyTangoFawks/ModBench/issues/62)
  (cross-tree highlight).
