# Plugins — Surface Specification

**Status: Implemented.** There is **one** Plugins tree (`modbench.pluginListTree`), covering
what were once separate Mod-Management "Plugins (Load Order)" and Editing "mEdit Plugins tree"
surfaces ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md)).

**Two bounded contexts, one view, structurally.** Mod Management owns the rows — identity, Plugin
load order, checkbox — operating on physical plugin files (`.esm`/`.esp`/`.esl`) and
`plugins.txt`, never on records or FormKeys. The Editing context owns a row's children — record
types, records, the spatial worldspace/cell hierarchy — whenever the backend is running.
Neither side imports the other's vocabulary
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), each context's own `CONTEXT.md`); the join is a thin
composite at the composition root (`PluginsTreeComposite`, `modbench/src/extension.ts`), not a
change to either provider. This structural split is what answers ADR-0027's
objection to merging these views: the merge is not a conflation of contexts, it is a shared row
with an owner per axis.

**Vocabulary note:** "load order" is ambiguous across Modbench's two contexts and this spec
uses the disambiguated terms throughout — see [CONTEXT-MAP.md](../../CONTEXT-MAP.md) and each
context's `CONTEXT.md`:

- **Mod override order** — `modlist.txt` order (the **Modlist**, owned by the Mods tree); the mod
  nearer the **winning end** (top of file) wins **file** conflicts — never "later position".
- **Plugin load order** — `plugins.txt` order (owned by this surface); the **last-loaded** plugin
  wins **record-override** conflicts (an Editing-context concern this surface's artifact feeds).

## Purpose

Reconstruct MO2's Plugins tab — view and manage `plugins.txt` (the Plugin load order) as a
first-class, always-available part of the Loadout workflow: enable/disable, drag-and-drop
reorder, missing-master detection — **and**, whenever the backend is running, be the entry
point for all per-record navigation in the mEdit view: browsing each plugin's records by type,
spatially by worldspace and cell, and narrowing by name or by a SQL record filter. In xEdit these
are one tree; this surface is Modbench's answer to the same design
([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)).

## Placement ([ADR-0027](../adr/0027-mo2-surfaces-map-to-native-vscode-views.md), [ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

A sidebar `TreeView` (`modbench.pluginListTree`, "Plugins"), stacked below the Mods tree in the
`modbench` view container, **always visible, unconditionally** — not a switchable tab, no view
mode, no gate of any kind. **With no backend the rows are leaves** and this surface
behaves exactly as the Mod-Management Plugin List always has; launching mEdit makes rows
collapsible, which is the whole of the "editing is available now" signal (see Row children
below). Reuses the `TreeDragAndDropController` pattern already built for the Mods tree
([mods.md](mods.md) §UI — Mods tree) for reorder.

Freely relocatable by the user (e.g. to the auxiliary bar, to reconstruct MO2's literal
side-by-side layout) via VS Code's native "Move View" — but never defaults there, per
ADR-0027's auxiliary-bar convention.

## Problem Statement

Modbench already reads and writes `plugins.txt` internally — `loadOrderSnapshot.ts` derives the
editing backend's Plugin load order from it — but nothing lets a user *see or manage* it. A
plugin whose master loads after it will CTD the game with no warning in Modbench; today the
only way to inspect or fix `plugins.txt` is MO2's own Plugins tab or a hand edit.

Once a backend is running, a mod author also needs to find a record before they can do anything
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

Whenever the backend is running, every row also expands into that plugin's records — by
type, spatially by worldspace and cell — narrowing on two independent axes: the row-level name
filter above, and a SQL record filter scoped to a row's children. Every path through the
record-browsing side ends at the [Record editor panel](medit-record-editor.md).

The load order is constructed on entry from every line of the active profile's `plugins.txt` —
disabled entries included, carrying their participation (ADR-0035) — plus vanilla masters;
there is no separate load-load order step.

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
   mod-granularity) missing-master badge on the same plugin — and, once the backend is running and
   a richer load-order-derived verdict exists for the same master, I want the two merged into one
   badge rather than shown as a second decoration that might contradict the first (see Missing-
   master badge (order-aware) and load-order-derived master/load-failure decoration).
8. As a user, I want to drag a plugin to a new position and have `plugins.txt` reordered
   immediately, so that fixing a load-order problem is a direct manipulation, not a form.
9. As a user, I want to ctrl/shift-click to select multiple plugins and drag them together as
    a block, so that reordering a cluster of related plugins doesn't take one drag per plugin.
10. As a user, I want a filter that narrows the list to plugins whose filename matches
    what I type, so that I can find one without scrolling a 100+-entry load order.
11. As a user, I want one Refresh, in one place, that re-reads every list at once if any of
    them looks stale (e.g. after an external MO2 edit), so that I never have to remember
    which tree owns which refresh (it lives on the
    [Loadout header](loadout-header.md)).
12. As a user, I want to right-click a plugin and Reveal it in my OS file manager, so that I
    can go inspect the actual file behind a badge without hunting for it myself.
13. As a user, I want this list visible at all times, with no separate open/launch step, so
    that it behaves like the Mods tree it's stacked with, not like the occasional-use
    Downloads tab.
14. As a user, I want a clear error state if `plugins.txt` can't be read, so that a corrupt or
    missing file doesn't just silently show an empty list.
15. As a user, I want installing, uninstalling or reprioritising a mod to update a loaded
    plugin's records automatically when that changes *which file* the plugin name resolves to,
    so that I am never stuck quietly browsing records from bytes my loadout no longer points at
    — and never have to notice or ask for it myself.

### Record navigation (Editing, once the backend is running)

15. As a user, I want to expand a plugin row and see its record types, then every record under a
    type in one step, so that browsing works the way it does in xEdit — no manual "Load more…" click
    (measured: no meaningful cost even at the realistic worst case; see Record navigation
    below).
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
23. As a user, I want to create a new plugin, add a record to a plugin, and remove records (with
    a confirmation that lists everything selected), so that the common authoring operations are
    all in the tree.
24. As a user, I want to open a plugin's header as a first-class record by clicking the plugin
    node — viewing its author, masters, and flags in a single-column panel, and (on editable
    plugins) editing them through the normal edit path: set the author, toggle ESL/ESM (rejected
    at edit time when the plugin isn't ESL-eligible) — so that maintaining a plugin's header is
    an ordinary working-tree edit, reviewable in the Source Control panel like any other.
25. As a user, I want to create and manage placed references (REFR/ACHR) inside a cell's
    persistent or temporary group, so that I can edit world placement spatially.
26. As a user, I want a plugin whose master can't be resolved flagged and still fully browsable —
    never deactivated, excluded or hidden — with the tooltip telling me whether the master is
    missing entirely or is present but itself failed to load, so that I can inspect and fix the
    problem instead of losing the plugin from the tree. If a plugin fails to open or parse
    outright, I want its row to stay and show me why, rather than the load silently continuing
    without it ([ADR-0037](../adr/0037-unresolvable-masters-are-indexed-and-flagged.md)).

## Implementation Decisions

### Scope

- This spec covers the whole merged surface: the sidebar tree, checkbox, drag reorder, the
  order-aware missing-master badge, the name filter, Refresh, Reveal-in-Explorer, and —
  whenever the backend is running — record browsing, the spatial hierarchy, the SQL record
  filter, record-authoring commands, and the load-order-derived master-issue and load-failure
  decorations (ADR-0037).
- **Auto-sort** (dependency-aware topological sort, LOOT parity) is **out of scope, deferred
  indefinitely** — a possible future initiative of its own, not scheduled. See Out of Scope.
- **Cross-highlight with the Mods tree** (selecting a plugin highlights its providing mod(s)
  and vice versa, MO2 parity) is **deferred** — blocked by a real VS Code
  API limitation, not a priority call. See Out of Scope.
- **No "Mod" column.** Which mod provides a plugin is surfaced only via the (deferred)
  cross-highlight, matching MO2's own implicit-link design.

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
  ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md)):
  a checkbox on a togglable `plugins.txt` line (`contextValue: "plugin"`); a lock icon on an
  implicit master (`contextValue: "pluginImplicit"`, discovered from the game's Data folder rather
  than a `plugins.txt` line) — forced on, neither toggled nor dragged; nothing at all on a row that
  stands for no plugin file in the load order at all (today only the sentinel error/empty
  rows — non-participating copies are not displayed). The lock has one
  meaning: it is never about record editability, only about this row's own
  toggle/drag facts, which Mod Management already owns without needing the editing backend.
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
  contexts — once a load order reports it, as a tooltip appended to whatever tooltip the row already
  carries (e.g. the missing-master badge below). It is never a `contextValue`: no per-row editing
  command exists yet to gate off one, and adding that plumbing before a command needs it would be
  exactly the speculative scaffolding this project's conventions rule out. **Selecting an immutable
  plugin's row still opens its header, ungated** — viewing a plugin's header is not an editing
  action, only the fields inside it are (see Record navigation below); an immutable plugin's row
  otherwise has no editing action to hide today, since none is contributed on a plugin row yet.

### Row children ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

- **With no backend running every row is a leaf** and nothing on the Mod-Management side of this
  surface changes. Launching mEdit makes rows collapsible; **chevrons appearing across the
  tree are the whole "editing is available now" signal** — there is no banner and no mode.
  Closing mEdit returns every row to a leaf. Neither transition re-reads `plugins.txt`, so
  the load order, the name filter, row expansion and scroll position all survive it.
- **Expanding a row browses that plugin's records** — record types, the spatial
  worldspace/interior-cell hierarchy (the interior-cell listing itself still pages), and record
  nodes, every one of a type in a single call (see Record navigation below).
- **A row expands only if the load order actually holds its plugin.** A row whose plugin is not in
  the load order stays a leaf rather than opening onto an empty list, which would read as "this
  plugin has no records" (ADR-0026).
- **Disabled plugins expand and browse like any other.** The load order indexes every `plugins.txt`
  line, enabled or disabled; the `*` prefix is *participation* — whether the plugin competes for
  winner — not whether it is loaded. A disabled plugin can never be the winning record for a
  FormKey and never takes part in conflict classification.
- **Every physical plugin copy is registered, not only the load order's picks** (ADR-0044). A
  copy losing the Mod override order, and a file no `plugins.txt` line names, arrive in the same
  snapshot as the winners and are held beside them — non-participating and read-only, but **not
  displayed**: `PluginListProvider` reads only `plugins.txt`'s own line set for rows, and a
  plugin more than one enabled mod provides renders exactly like any other row. How a losing or
  unlisted copy surfaces — per-reason show/hide toggles, dimming, origin labelling — is an open
  UX design; an always-on Stack node and file-override badge were reviewed live and rejected
  (ADR-0035).
- **The seam is a thin composite at the composition root** (`PluginsTreeComposite`), not a change
  to either provider: Mod Management owns the rows, the record browser owns the children, and
  neither imports the other's vocabulary — enforced by `src/test/contextBoundary.test.ts`, not by
  review. A drop onto a child row is refused rather than treated as "past the last row", which
  would silently move the dragged plugins to the end of the load order.

### Progressive load ([ADR-0035](../adr/0035-one-plugins-tree-editing-is-a-capability.md))

The load is progressive **and states its own incompleteness**. Both halves are the point: the
trap this closes is that **an absent conflict badge is indistinguishable from "no conflict"**. If
browsing opens at second five and the winner sweep lands at second ninety, then for eighty-five
seconds an unmarked record silently claims to be conflict-free when nothing has looked — the same
class of error as `is_winner` describing a load order that does not exist. Showing things sooner
without saying what is not yet known would make that worse, not better.

- **Rows gain chevrons individually, as each plugin finishes indexing** — not all at once at the
  end. A plugin the load has not reached yet stays a leaf, so a row never expands onto records
  that are not queryable yet.
- **The view's own header carries the progress indicator** for the whole operation — backend
  spawn, indexing, and the winner sweep (`withProgress` addressed by view id). Not a
  notification: two indicators for one operation is noise. The header bar carries no text, so the
  step messages go to `TreeView.message` instead.
- **`TreeView.message` states, in as many words, that conflict information is not yet computed**,
  for as long as the winner sweep is outstanding. It clears itself when the sweep lands — no user
  action, no Refresh.
- **Before the first plugin lands, the message names the work rather than the count.** Indexing
  interleaves opening and indexing per plugin, so on a real load order the first plugin is a
  base-game master big enough that `0 of N` is *truthful* for a long stretch — and reads as a
  stall. The zero-count phrasing therefore says work is under way on the first plugin(s), keeping
  the count visible rather than replacing it.
- **No conflict badge is rendered before the sweep completes.** The record conflict badge and the
  Conflicts node (see *Conflicts node and conflict badge* below) both gate on `LoadOrderStatus.conflictsComputed`
  (`PluginTreeProvider.conflictAllOf`/`conflictsNode`) and render *nothing* — not "no conflict" —
  while it is false.
- **Gate on `conflictsComputed`, never on "is a load running".** They coincide today but are
  deliberately separate fields (`LoadOrderStatus.cs`): the sweep is whole-set, so ADR-0035's live
  mutations (reorder, enable, disable) will leave a finished load order with stale winners until it
  is re-run.
- **Per-plugin load failures decorate their rows the moment they are reported**, through the same
  `setLoadOrder` channel as everything else the load order reports — not held back to the end.
- **Master issues stay off the rows until the load completes.** They are a whole-load-order
  derivation: mid-load they would flag masters that simply have not been opened yet. The backend
  suppresses them outright while loading (`RecordQueryService.GetPlugins` gates on
  `LoadOrderState.Ready`) and the frontend never asks for them mid-load.
- **Closing mEdit is a deliberate abandonment, not a failure — at any point in the launch.**
  The polling stops, chevrons/message/progress clear, and nothing is reported as broken. This
  holds for the whole launch, not just the load: a close during the backend spawn and mod-tree
  walk must not report "Backend failed to start" for the stop the user just asked for, so the
  cancellation is armed before the launch's first await and checked after each one. Same for a
  load superseded by another load, which the backend answers `409` — the newer load owns the
  load order, so the abandoned one must not tear anything down.
- **A second window on the same instance is refused, by name.** The backend answers the load
  `423 Locked` ("this instance's index is open in another Modbench window") and holds nothing; the
  frontend surfaces that message as the load failure. No read-only mode, no waiting, never a second
  index file ([ADR-0001](../adr/0001-persistent-per-instance-index-session-is-a-registration.md)
  point 6).
- **Mechanism: poll, don't stream.** Every call goes through the generated `openapi-fetch`
  client, which has no streaming path, and the load POST stays blocking. So `GET /load-order/status`
  is polled alongside the still
  in-flight `PUT /load-order`, which remains the completion signal. Cadence lives in
  one named constant, `STATUS_POLL_INTERVAL_MS` (`EditingController.ts`), set to 500ms to
  match `BackendManager`'s own health-poll cadence; it is the single dial for any tuning pass.
- **A progress tick is never the last word.** Ticks carry only the indexed set and the failures;
  the completed load's hand-off (`applyLoadOrderToTree`) always follows the final tick and
  carries read-only state and master issues with it. Were a tick ever last, both decorations
  would silently vanish from a fully loaded tree.
- A tick re-renders only when something actually landed: `setLoadOrder` fires a whole-tree refresh
  and `PluginTreeProvider.getPluginChildren` is uncached, so an unconditional re-render every
  poll would re-fetch record types for every expanded row.

### Record navigation (Editing, once the backend is running)

- **Plugin nodes** (`contextValue: "plugin"`, or `"pluginImplicit"` for an implicitly-loaded
  vanilla/DLC master not named in `plugins.txt` — see Row model above; read-only-for-editing is a
  tooltip `PluginsTreeComposite` appends, never a third `contextValue`, per Row model above).
  **Clicking/selecting the row opens its header record** — author, masters, flags — as a
  single-column record panel, retargeting the singleton editor panel
  (the plain-`modbench.openEditor`
  policy). This is xEdit parity, not an invention: `vstNavChange` /
  `TryViewOrCompareSelectedRecords` (`xeMainForm.pas`) show a selected file node's File Header in
  the view pane as a side effect of selection alone, with no separate affordance — so there is no
  "Open Header" button here either — `PluginNode` and
  `ImplicitMasterNode` (`modmanager/PluginListProvider.ts`) each wire their own `.command` to the
  `modbench.openHeader` bridge command that used to back the retired button, so the gesture is
  reachable identically from both plugin-bearing row kinds. A plugin's context menu also exposes
  New Plugin…, Track… (untracked plugins), and — on editable plugins only — Save & Compile, Add
  New Record…, Convert to ESL/ESM, and Run Script…. Each is a confirmation or picker as
  appropriate; destructive ones confirm.
- **Record-type nodes** (`contextValue: "recordType"`): labeled by the type's **human-readable
  name** (e.g. "Activator" for `ACTI`, "Game Setting" for `GMST`), matching xEdit's naming from
  `wbDefinitionsFO4.pas`; the raw 4-char signature remains the internal identifier (cache
  keys, `contextValue`, commands, API `type`). Children are **every record of that type, loaded in
  one `getChildren` call — no pagination, no "Load more…" step**. Measured: the
  backend's `/records` query has no artificial limit, and the realistic worst case a Bethesda load
  order can put in front of this surface — a single plugin's own contribution to one record type,
  since that's the unit a `RecordTypeNode` scopes to — is vanilla `Fallout4.esm`'s own `INFO`
  (Dialog response) records, ~78,000 of them in a full real-world FO4 modlist (a 592-active-plugin
  MO2 instance; every mod plugin checked, including the largest quest mod in that
  list, stayed under 13,000 for its own biggest type — vanilla dwarfs mods here). At that count:
  ~125-280ms for the full backend query (DuckDB, `LIMIT`/`OFFSET` with no artificial cap) plus an
  estimated ~280ms to materialize and hand off the `TreeItem` batch extension-host-side (synthetic
  benchmark, upper-bound proxy) — comfortably sub-second end to end, one dev machine, Debug build.
  VS Code's own `TreeView` already virtualizes rendering, so row count alone was never the
  limitation pagination solved; xEdit itself shows a record-type group's full child list
  unconditionally (`xeMainForm.pas`'s `vstNavInitChildren`: `ChildCount := Container.ElementCount`,
  no `LIMIT`), so this also removes an ADR-0034 divergence that never had a demonstrated platform
  limitation behind it.
- **Record nodes** (`contextValue: "record"`, or `"recordImmutable"` for a row whose plugin is
  read-only for editing — an immutable plugin or a shadowed copy, which hides Remove/Change
  FormID… though not Copy, see below): labeled `{EditorID}  [{RecordType}:{FormID}]`
  (FormKey only when no EditorID). Single-click (or Open Record) opens the editor; the context
  menu adds Remove (a confirmation listing every selected record, deleting the whole selection as
  one batch; the Delete key also triggers it) and Change FormID… (renumber), with xEdit's own
  captions, per [medit-version-control.md](medit-version-control.md) — Add lives on the
  record-type row above a plugin's records. Removing a record deletes its source file as an
  ordinary working-tree change; an uncommitted create has no special-cased handling — its
  source file is simply removed the same way, since it was never committed to begin with.
- **Copy as Override Into…/Copy as New Record Into…**:
  available on both `"record"` and `"recordImmutable"` rows — unlike Remove/Change FormID…,
  copying *from* an immutable or shadowed source is the ordinary case here, not an exception — and
  identically from the record editor's own column header context menu, both entry points sharing
  one implementation path. A native QuickPick picks the destination plugin, filtered to mutable
  plugins only; Copy as Override additionally excludes every plugin that already carries the
  record (xEdit parity, `xeMainForm.pas`'s `CopyInto` — a plugin cannot hold two overrides of the
  same FormKey), which Copy as New Record does not apply, since its fresh FormKey always coexists
  with the source. Copy as New Record prompts for neither an EditorID nor a FormKey: it lands
  immediately under the source's own EditorID and the next free local FormID, renamed afterward
  like any freshly created record (Add's own posture, above). Any rejection out of the
  destination-picking step — not just transport failures — degrades to a Modbench-authored
  error notification plus an output-channel log, then ends the command quietly like a cancelled
  QuickPick (the backend-died-after-render exposure; same disposition as Save & Compile's
  palette fallback).
- Context menu availability is driven by node `contextValue`, sourced from whichever side of
  the composite built the row: Mod Management for plugin rows (`"plugin"`, `"pluginImplicit"`),
  the record browser for everything a row expands into (`"recordType"`, `"record"` /
  `"recordImmutable"`, `"refr"` / `"refrImmutable"`, and the spatial contextValues below).

### Record filter (SQL)

- The record tree is filtered by a **filter file** — a plain `.sql` file containing a DuckDB
  `SELECT` returning `form_key`. While active, record types and records with no matching
  records are pruned, and **a plugin with zero matching records is hidden entirely** — including
  a load-failed or missing-master plugin, which is otherwise always visible. `GET /plugins`
  itself never drops a plugin row (`HasMatchingRecords` is an additive per-plugin fact, backend-
  tested); the hiding is a presentation decision in the Plugins tree, made only while a filter is
  active. Clearing the filter restores every hidden row immediately, in load order. (ADR-0035
  amends [ADR-0018](../adr/0018-sql-file-based-record-filter.md) on record/record-type pruning
  and on plugin-row hiding.)
- Entry points: a title-bar funnel (opens a `setFilter` quick pick of `.sql` files in
  `modbench.scriptsPath` plus "New filter…"), a funnel-slash to clear (shown only while a
  filter is active), command-palette equivalents, and **Code Lens** on open `.sql` files under
  `modbench.scriptsPath` ("▶ Apply as Filter" when the file differs from the active filter; "✓
  Active — click to clear" when it is the active filter). A `filterActive` context key drives
  the active indicators.
- If reading the active-filter state fails (backend error), the sync degrades to *inactive* and
  warns the user rather than silently presenting the unfiltered tree as a confirmed "no filter"
  ([ADR-0026](../adr/0026-error-surfacing-policy.md); same degrade-and-warn convention as other
  secondary reads). The failure is non-fatal to launch.
- Conflict-status filtering, EditorID search, and record-type narrowing are all expressed as
  user-written SQL — **no structured toggle UI**. Per ADR-0041/ADR-0005 the per-type names are
  generated `json_extract` **views** over the one `records` documents table, so existing
  per-type filter SQL keeps working by name. View columns are **scalar leaves only** with types
  preserved via casts: primitives, plain enums, FormLinks, translated strings (their `Value`),
  and `[Flags]` enums as comma-joined member names (filter with `LIKE '%FlagName%'`; `''` when
  unset). Arrays, structs, and widened/split columns have **no view column at
  all** — a record's nested structure lives in its JSON document (`records.document`,
  reachable with `json_extract` directly for power users). The filter runs once into a
  materialised set when applied, so its cost is per-apply, not per-listing.
- **Filter to Selected Plugins**:
  `modbench.pluginListTree.filterToSelected`, adopted from xEdit's `mniNavFilterApplySelected`
  (`xeMainForm.pas:13976-14027`) — the ordinary record filter above, invoked against the current
  tree selection, not a mode and not a second filter language. Reachable from a plugin row's
  context menu (`plugin`/`pluginImplicit`; `pluginActions@6`), it works across a
  multi-row selection (the tree is already `canSelectMany`) and applies
  `SELECT form_key FROM records WHERE plugin IN (...)`, scoped to the deduped, safely-quoted set
  of selected plugin names, against the `records` documents table directly — one query already
  covers every record type a selected plugin owns, so this needs none of the per-type `UNION ALL`
  ADR-0018 deferred for cross-type queries. The readout names it statically ("records: Selected
  Plugins"), the same as any other filter source. **One deliberate divergence from xEdit,
  ADR-0035:** `mniNavFilterApplySelected` resolves a selected *element* up to its owning file
  (`ReInitTree`, which also deletes unselected files' nodes — refused here, see above); this
  command instead drops a non-plugin row from a mixed selection rather than rolling it up,
  since resolving one would require its selection-extractor (Mod Management) to understand
  Editing's child-row shapes, exactly the cross-boundary knowledge the bounded-context split
  forbids. In practice the drop only ever manifests in a mixed selection, since the context menu
  itself only offers the command on a plugin row to begin with.

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
  the same lifecycle actions as a record row — Remove, Change FormID… — with the same handlers
  and immutable gating. CELL nodes have no menu.

### Quest / dialog topic children

- Shallow containers (ADR-0040) strip a Quest's dialog topics/branches/scenes and a Dialog
  Topic's responses out of the parent's own record/document — the Plugins tree restores
  navigation to them as expandable tree children, reading the same containment index the
  worldspace tree above reads, never a parallel source.
- A Quest row expands to its `DialogTopics`, `DialogBranches`, then `Scenes`, in that flat order
  with no intermediate grouping node — xEdit's own GroupType-10 order
  ([ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)). A Dialog Topic row
  (whether reached directly or as a Quest's child) expands to its `Responses`.
- Child rows are ordinary record rows — same `modbench.openEditor` command, same context menu,
  same origin-keyed identity as every other record row (no new command was needed for this).

### Missing-master badge (order-aware) and load-order-derived master/load-failure decoration

Two independent signals can land on the same plugin row, from two different sources, and
[ADR-0037](../adr/0037-unresolvable-masters-are-indexed-and-flagged.md) is what keeps them from
reading as disagreeing decorations.

**Order-aware (Mod Management, no load order needed).** Stronger than the Mods tree's badge, and
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

**Load-order-derived (Editing, once the backend is running — ADR-0037).** Presence-only, never
order-aware — Mutagen resolves a master by reading it from the plugin's own header, so it never
needs that master positioned before the plugin, only present and loadable somewhere in the
load order. `GET /plugins`' `masterIssues` reports, per plugin, every one of its own declared masters
that didn't resolve, classified two ways: `DirectlyMissing` (never part of the load order at all —
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
load-order-derived wording — richer because it distinguishes directly-missing from unloadable, a
distinction the order-aware check has no way to make from a plain-text read of `plugins.txt`. A
master the order-aware check flags that the load-order-derived signal does *not* — present in the
load order, loaded successfully, but sequenced after this plugin's own line — is preserved and
worded distinctly ("is not loaded before this plugin"), since that is a real CTD risk the
load-order-derived signal structurally cannot see (order doesn't affect Mutagen's own resolution).
When a load order is not running, or the load-order-derived signal has nothing to say about a row, the
order-aware badge renders exactly as it does today, untouched.

**Neither signal, nor the reconciled decoration, nor the load-failure decoration below, ever
touches the leading slot.** The checkbox/lock position is reserved for exactly one question —
"can you change whether this loads?" (see Row model above) — and every decoration in this
section is icon, description and tooltip only.

**Load-failure decoration (ADR-0037).** A plugin that fails to open or parse is
skipped so the rest of the load order still loads (`LoadOrder.LoadFailures`), but its row is
never dropped — Mod Management builds rows from `plugins.txt`, not from which plugins the load order
managed to index, so the row was already there. `PluginsTreeComposite` decorates it with its
recorded failure reason ("Failed to load: `{reason}`") the same way it decorates a master issue;
the row stays a leaf, since a plugin that never indexed has nothing to expand into. The existing
reconcile toast (`EditingController.putLoadOrder`, one aggregated warning per load) is
unchanged and is not duplicated by this decoration — the same failures reach both, from the same
response, so there is exactly one notification and one persistent, per-row explanation of why.

### Compile-staleness decoration

The state level of the Resolution stack (`CONTEXT.md`): within
a tracked plugin, source stacks on the compiled binary, and this is the always-on signal that the
two have diverged. This is an Editing fact about a tracked plugin's own git state — "the game
can't see your edits yet" — not a Mod-Management fact about which physical file a name resolves to.

- **Trigger.** A plugin row is compile-stale exactly when its source (the working tree, or a
  commit landed since — commit stays ungated, ADR-0041) has moved past what
  `refs/medit/last-compile/<plugin>` parked (`Save & Compile`, `CONTEXT.md`) — computed backend-side
  (`ModFolders.CompileFreshnessOf`, `PluginResponse.CompileStale`/`LastCompiledAt` on every
  `GET /plugins`), cheap and bounded by dirt per the freshness philosophy
  ([medit-version-control.md](medit-version-control.md)): two git calls scoped to the plugin's own
  `source/<plugin>/` subtree, never touching record count or load order. Never shown for an
  untracked plugin, or a tracked plugin Track never parked a ref for (New Plugin into an
  already-tracked mod folder, before its first compile) — both degrade to "nothing to compare
  against" rather than a false positive.
- **Visual encoding — load-order-derived, the same machinery as the missing-master/load-failure
  decorations above (`PluginsTreeComposite`, icon/description/tooltip, append-never-replace),
  not the file-override family's `FileDecorationProvider` tint:** this is a git-tracked-state fact
  requiring a load order, not a filesystem one. A **description hint** (`⟳ Source ahead`) and a
  **tooltip** ("Source ahead of binary — last compiled `<when>`", or "last compiled unknown" for a
  ref with no readable timestamp) are appended after (never replacing) whatever the row already
  carries. Deliberately **never claims the icon slot** — it never steals `iconPath` from a
  higher-severity decoration already on the row (a load failure or a master issue), and renders no
  icon of its own when neither of those claimed it either: the description hint is the primary
  signal here, not an icon.
- **Coexists with every other decoration on this tree.** A plugin can be compile-stale and carry
  a master issue, or a load failure, all at once, and every decoration remains legible —
  append-only by construction, the same convention the read-only-note decoration above already
  establishes.
- **Refresh.** No watcher (freshness philosophy: read/refresh time, never a watcher). Seeded at
  reconcile off the same `GET /plugins` answer every other load-order-derived fact in this
  hand-off already reads, and re-derived — without a reconcile — after a successful
  **Save & Compile**, riding the same refresh `EditingController.setFilter`/`clearFilter` already
  trigger (`refreshMatchingPlugins`, extended for this) rather than a second poller. A refused
  compile changes nothing about any plugin's git state and triggers no refresh.
- **Scope.** Plugin rows only, tracked plugins only — an untracked plugin has no state layer to
  diverge (`CONTEXT.md`: "Editing requires tracking; viewing never does").
- **Out of scope here.** Any auto-compile behavior — this is only the always-on row-level
  signal that something there is worth investigating.

### Conflicts node and conflict badge

ADR-0016's two-axis
model (record-wide `ConflictAll` / per-cell `ConflictThis`) is the settled design; only Axis 1
drives anything on this tree — Axis 2 stays the compare grid's own concern
([medit-record-editor.md](medit-record-editor.md)'s "Conflict color coding").

- **Trigger and placement — root-level, not per-plugin.** Not a per-plugin child
  `getPluginChildren` builds: the Conflicts node is a load-order-wide sibling of the plugin rows — a record's override stack inherently spans more than one plugin, so there is
  no single plugin row it could belong under. `PluginsTreeCompositeDeps.children` gains an
  optional `conflictsNode(): TChild | undefined` accessor, consulted once at the root and
  prepended ahead of every plugin row when present — never added to the composite's `rowsSeen`,
  so it routes through the `children` side for its own `getChildren`/`getTreeItem` the same way
  every other record-side node does (confirmed by an executable routing test, not merely by
  construction).
- **Gated on `conflictsComputed`, omitted entirely — never rendered empty (the progressive-load invariant).**
  `PluginTreeProvider.setConflictsComputed`/`conflictsNode` mirror `loadOrderProgress.ts`'s own "no
  conflict badge before the sweep completes" rule: `conflictsNode()` answers `undefined` (the
  node absent, not present-with-nothing-in-it) while `LoadOrderStatus.conflictsComputed` is false.
  Wired from `EditingController`'s `notifyConflictsComputed` dep — the same load-completing
  false→true transition point the incompleteness message and the record panel's own comparison
  refetch already use. Every reconcile that changes anything — a toggle, a reorder, a mod-level
  change — re-fires it too (ADR-0044, reusing the same signal rather than adding a second
  state-machine step).
- **Children: `GetConflicts()`** (`RecordQueryService`, `GET /records/conflicts`) — every FormKey
  with more than one override entry (`IRecordReads.GetContestedFormKeys`) whose record-wide
  `ConflictAll` is not `OnlyOne`/`NoConflict`, classified through the same `ClassifyStack` helper
  `GetCompare` uses (so "is this record conflicting" can never answer differently here than it
  does when the record is actually opened), rendered as ordinary `RecordNode` rows (reused, not a
  bespoke node type — the same click-to-open behavior every other record row has).
- **Respects the active record filter from birth.** `GetContestedFormKeys`
  is routed through the same `BuildWhere`/`_filterActive` mechanism `GetRecordTypeCounts`/`Search`
  already use — the shipped filter-pruning mechanism, not a second filter path. A filter prunes
  which conflicting records the node lists; it never removes the node itself, mirroring the
  "a filter prunes records and record types, never a plugin row" rule.
- **The conflict badge shares the existing M/A working-tree provider** (`RecordDecorationProvider`)
  rather than a second one — a row has exactly one `FileDecoration`. M/A wins when present
  (an uncommitted local edit is the more actionable, load order-local fact — orchestrator-approved
  default); the conflict color/badge (`O`/green for Override, `C`/git-conflict-token for Conflict,
  `!`/red for ConflictCritical — reusing existing sanctioned `ThemeColor`s, no new ones) shows
  otherwise. Nothing at all for `OnlyOne`/`NoConflict`, or when the lookup has nothing to say
  (not computed, or nothing has fetched this record's conflict state yet) — never a badge that
  could be mistaken for "no conflict".
- **Deliberately scoped: the badge renders only on the Conflicts node's own rows**, not on every
  ordinary record row wherever a plugin is browsed. A load-order-wide persisted `ConflictAll` for
  every record (computed during the winner sweep, so it's cheap to attach anywhere) is
  architecturally the "complete" answer ADR-0016's own implementation notes anticipated, but it
  would touch the live-mutation hot path (reorder/enable/disable's own re-sweep) and widen
  `RecordSummary` for every caller — a materially bigger, separate piece of work if wanted, not
  a silent scope expansion of this one.

### The load order is mirrored, not loaded ([ADR-0044](../adr/0044-the-load-order-is-mirrored-not-loaded.md))

Every loadout gesture — a reorder, an enable/disable, installing, uninstalling or reprioritising
a mod, a profile switch, activation itself — is the same thing to Editing: the next snapshot.
Mod Management recomputes it (`buildLoadOrderSnapshot`: the winning copy of every `plugins.txt`
line at its slot with its `*`, every losing copy at the name's slot, every unlisted file with no
slot — origin, path and the three registration facts, nothing richer) and sends it whole as
`PUT /load-order`; the backend reconciles it against what it holds (open and register what is new,
indexing only files the mirror has never seen; unregister what is gone; move the slot/flags of
what stayed, SQL-only; one winner sweep). An identical snapshot is a no-op. There is no decoration,
no confirmation, no command, and no user-facing "drift" or "re-read" concept — a mod-level change
that moves which copy wins is just the `winning` flag moving on two rows the backend already holds.

**How a change reaches the backend.** Every trigger calls `loadOrderSync.request()`
(`src/loadOrderSync.ts`, a composition-root joiner that imports from neither context — the pattern
`PluginsTreeComposite` and `nameFilter` already use, enforced by `src/test/contextBoundary.test.ts`):
Mod Management's own watchers — `profiles/*/modlist.txt` (rewritten by install, uninstall and
reprioritise alike), `mods/**` (a folder appearing or vanishing without one) and
`profiles/*/plugins.txt` (a reorder or an enable/disable, whether Modbench wrote it or MO2/the
user did) — plus the checkbox toggle's own explicit ask and the profile switch's. No polling.
Requests coalesce (a 250 ms debounce covers a drag's write plus its watcher event, or two watchers
firing for one install), and a request that lands mid-PUT becomes exactly one more PUT after it,
never a race. The sync drops a request when no backend is running — a loadout-only workspace is
the ordinary case, not a failure. One PUT is one reconcile (`makeReconcileLoadOrder`, `extension.ts`):
snapshot → `EditingController.putLoadOrder` → filter sync → `applyLoadOrderToTree`, the same
sequence Launch mEdit runs after the backend comes up.

**A failed PUT tears nothing down.** The backend keeps whatever it held; the error is surfaced
(ADR-0026's explicit-action tier) and the next snapshot retries. A copy that cannot be opened or
indexed is a row in an error state (`LoadOrderStatus.failures`, decorated on its row), retried only
once its bytes change. There is no "exit to Loadout on load failure" any more.

**Uninstalling the only provider of a held plugin** unregisters that copy — its rows stay in the
mirror for its return (a reinstall registers them again with no re-index), and its row in this tree
(built from `plugins.txt`, not from what the backend holds) simply stops expanding.

**A tracked plugin's copy switching folders follows its new folder, the same way any reconcile
resolves a tracked plugin** — source-tree ingest if the newly winning origin is tracked, binary
otherwise. Nothing migrates and nothing is lost: a tracked mod's edits live in its own git
repository, independent of the DuckDB read model, so an origin switch means a different repository
with its own history, untouched by the switch. Every completed reconcile fires
`notifyConflictsComputed`, which is what re-registers every tracked mod folder with `vscode.git`
(`registerHeldTrackedRepositories`) — a newly-tracked origin's repo appears without a second
bespoke mechanism.

**No new presentation was built for this.** The PUT is one blocking round trip — open and index
what is new, re-register the rest, re-sweep winners, respond — with the Plugins view's own header
progress indicator (`withPluginsViewProgress`) and `TreeView.message` as the only feedback while it
is outstanding, exactly as a launch; the rows simply reflect the reconciled state via the ordinary
`applyLoadOrderToTree` hand-off once it lands.

### Record-row working-tree decoration

A record row carrying an uncommitted working-tree change is badged with git's own single-letter
vocabulary (`M`/`A`, `gitDecoration.modifiedResourceForeground`/`addedResourceForeground`) via
`RecordDecorationProvider`, a `vscode.FileDecorationProvider` keyed on each `RecordNode`'s
synthetic `medit-record:` resourceUri. Deleted is out of scope (`Search()`, what this tree lists,
is Effective-only, so a working-tree-deleted record has no row to badge) — the native Source
Control panel shows that `D` for free. Full contract:
[medit-version-control.md](medit-version-control.md).

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

- **Slot 1 — name filter**: the shared Modbench filter widget (`registerNameFilter`,
  `modbench/src/nameFilter.ts`), live-narrowing plugin rows by case-insensitive substring match
  against filename. One widget spans every Modbench list surface: Mods, Downloads, and here,
  with one behavior — durable until explicitly cleared, term in the view description,
  `ctrl+F` as a second entry point (full description in [mods.md](mods.md)). It is a
  **distinct axis** from the record filter: this narrows *which plugin rows* appear; the record
  filter narrows *which records* appear under an expanded row. The two compose, and their icons
  say which is which — `$(search)` narrows by name, `$(filter)` narrows by condition. Slot 1
  swaps to `$(clear-all)` while a name filter is active, gated on
  `modbench.pluginListTree.filterActive`.
- **Slot 2 — record filter and its Clear** — the SQL record filter described above; a no-op
  with no backend running (there is nothing to filter yet). Its own gate is
  `modbench.filterActive` — a separate key from slot 1's, because the two axes are cleared
  independently. **Closing mEdit clears the whole of the record filter's state** — gate,
  code lens and readout — through the one writer every in-load order filter change already
  goes through, so the Clear action cannot outlive the load order that gave it something to
  clear.
- **Both axes read out in the view description** when both are active — `"arm" · records:
  cells.sql`. The record filter is named by its **source** (the `.sql` filename, or `document`
  when applied from an open editor; `SQL` when a load order-start sync reports a filter this
  frontend never saw it applied), never by its SQL text: a `WHERE` clause is not a readout.
  Clearing either axis leaves the other applied and still named.
- **Slot 3 — New Plugin…**.
- **Overflow — Launch mEdit / Close mEdit**:
  `modbench.modList.launchMedit` /
  `modbench.closeMedit`, gated on `modbench.workspaceIsMo2Instance` — the same MO2-instance
  gating the [Loadout header](loadout-header.md) applies to its own actions — and toggled by the
  `modbench.backendRunning` context key, the standard two-command/context-key toggle shape
  (only one of the pair is ever contributed for a given state, so it "counts as one icon" per
  `modbench/CLAUDE.md` rule 2). It lands in overflow rather than a `navigation@N` slot because
  this tree's navigation bar is already at rule 2's four-icon ceiling (name filter, record
  filter, New Plugin) before this pair is added; rule 5's own slot sequence ends "then
  overflow" for whatever arrives once a view's icon budget is spent, so overflow is this
  toggle's rules-compliant landing spot, not a downgrade. The maintainer's
  ruling: mEdit is "an option on the plugins view", not a workspace action, so it lives here
  and not on the [Loadout header](loadout-header.md).
- **Native Collapse All** — the merge made this the deepest tree in the product
  (plugin → record type → record), so it earns the affordance.
- **No Refresh of its own.** Re-reading `plugins.txt` is part of the single
  workspace-scope Refresh on the [Loadout header](loadout-header.md), which re-reads every
  Mod-Management source together. There is no reload of the editing backend to offer: the load
  order it holds is reconciled on every change (ADR-0044).

### Row context menu

- **Reveal in Explorer** (plugin rows) — resolves the plugin name to its physical path (same
  winner resolution `loadOrderSnapshot.ts` already performs via `FileConflictIndex`, falling back
  to the game's `Data/` folder for an unmanaged vanilla/DLC/CC plugin) and reveals it in the OS
  file manager. Same primitive as the Mods tree's existing "Open in Explorer"
  (`revealFileInOS`).
- Record-scope context menu entries (Remove, Change FormID…, Copy as Override Into…, Copy as New
  Record Into…) are described under Record navigation above — they apply to this tree's expanded
  rows the same way regardless of which side of the composite built the row above them.
- **Open Editor to the Side** (record rows and placed-reference rows, single or multi-select) —
  opens the selected record(s) in a fresh, non-retargeting editor, distinct from the singleton
  editor plain "Open" reuses and retargets. A multi-selection opens every selected record, each in
  its own such editor, landing as tabs in one new editor group beside the active one.
  Also reachable from the Referenced By tree's group rows.

### Write mechanism

- A pure `pluginsText.ts`, templated directly on `modlistText.ts`'s byte-faithful
  splice-transform pattern: parse `plugins.txt` into an ordered model view, mutate via surgical
  splice (`lineRanges`, `mo2/lineScan.ts`) — never model→re-serialization — so comments, blank
  lines, and CRLF/BOM survive untouched.
- `IModlistSource` gains the write-side counterparts to its read-only `readPluginOrder()`/
  `readEnabledPlugins()`: toggle a line's `*` prefix, and reorder lines — mirroring the shape of
  the existing `modlist.txt` mutators (`moveModToSeparator`, `reorderSeparatorBlock`).
- **Current mutation path**: reorder, enable and disable all still apply immediately and
  unprompted via the surgical splice write above — a direct `plugins.txt` edit, nothing else.
  `PluginListProvider` makes no backend call to do this itself (root `CLAUDE.md`: Mod Management
  never calls the C# backend); the composition root (`extension.ts`) is what bridges a mutation to
  the running load order, per the next bullet.
- **Checkbox toggles and drag reorders are live (ADR-0044).** Both write `plugins.txt` and
  then become the next snapshot (`loadOrderSync.request()` — the toggle asks explicitly, the
  plugins.txt watcher covers both); the backend moves the affected registrations SQL-only — no
  reload, no re-read, no re-index (proved at the mirror seam: a reorder or a disable changes the
  index's `Index` call count by zero) — and re-sweeps winners once. Winner status, conflict badges
  and any open record editor all reflect the change via the same `notifyConflictsComputed`
  broadcast every completed reconcile fires; the view-header progress indicator
  (`withPluginsViewProgress`) is the only feedback — no modal, no notification. With no backend
  running the sync drops the request and no network call is made — the ordinary case is unaffected.

### Entry point

- No open/launch command. The tree is simply always present — identical in spirit to the Mods
  tree itself, unlike Downloads' editor-tab-on-demand model — through a load order as well as
  outside one.

### Empty / error states

- **Read failure** (missing/corrupt `plugins.txt`) — a single error tree node, per the existing
  `modmanager/CLAUDE.md` convention ("show an error tree node instead of an empty list when a
  fetch/read fails"), warning surfaced via the injected reporter per
  [ADR-0026](../adr/0026-error-surfacing-policy.md).
- **Empty `plugins.txt`** (no lines) — realistically near-unreachable (vanilla masters always
  populate it) but handled for completeness: a single informational node, "No plugins," the same
  fetch-failure-is-an-error-node/empty-is-a-known-fact convention every tree in this product
  follows.
- Per `modbench/CLAUDE.md`: this holds for **load-more (pagination) fetches on the interior-cell
  listing** too (record-type listings never page; the interior-cell listing is the only
  surface here that pages) — a failed "Load more…" surfaces an error node for that parent
  while keeping the already-loaded pages and the retry affordance, and the error clears on a
  successful retry.

### Architecture / seams

- **Primary Mod-Management seam**: `pluginsText.ts` (parse + mutate), pure, Vitest-tested, no
  `vscode` import — same seam class as `modlistText.ts`/`metaIni.ts`/`downloads.ts`.
- **Missing-master order-check**: a pure function taking (a plugin's declared masters via
  `readMasters()`, the ordered plugin-name list, that plugin's own index) → a verdict. Lives
  alongside or extends `statusChecker.ts`.
- **Load-order-derived master classification** (ADR-0037): `MasterResolution.Classify`
  (`MEditService.Core/Queries/`), a pure function over data the load order already has
  (`LoadOrder.Plugins`, `LoadOrder.LoadFailures`) — no Mutagen re-read. Consulted once per
  `GET /plugins` call and reported on `PluginResponse.MasterIssues`; distinguishes `DirectlyMissing`
  from `Unloadable` and never cascades (only a plugin's own `Masters` list is consulted).
- **`PluginListProvider`** (`TreeDataProvider`, `modmanager/`): rows only, a
  `TreeDragAndDropController` reusing the Mods tree's established controller shape, and the row
  side of the Filter `InputBox` — none of this layer holds record-browsing logic. Exposes
  `orderIssueMastersOf(node)` so the composite can read the order-aware badge's flagged
  master names structurally, without parsing rendered tooltip text.
- **`PluginTreeProvider`** (`medit/`): a row's children — record types, records, spatial
  hierarchy — unchanged in ownership by the merge; its `getPluginChildren(name)` is the public
  entry point a row built elsewhere (by `PluginListProvider`) expands into, and it is unit-tested
  without VS Code (`PluginRepository`, not `ApiClient`).
- **`PluginsTreeComposite`** (`modbench/src/`, composition root): joins the two above and does
  nothing else. Imports from neither bounded context; its whole knowledge of both domains is
  `pluginFileOf`, the boundary object `CONTEXT-MAP.md` already names. Enforced by
  `src/test/contextBoundary.test.ts`, not by review. `setLoadOrder` also carries
  `readOnlyFiles`, `masterIssues` and `loadFailures` — one hand-off, not several, since all of it
  comes off the same load order and changes together; the composite decorates icon/description/
  tooltip only, never the leading slot.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — same standard as every
  other surface spec in this directory: given `plugins.txt` text + a mutation, assert the
  resulting text; given a plugin's masters + the ordered plugin list, assert the verdict; given a
  load order, assert the rendered node shape, labels, `contextValue`s, and interior-cell pagination
  through `getChildren`/`getTreeItem` against a stubbed repository. Never construct nodes directly.
- **Primary unit seam — `pluginsText.ts`** (Vitest, `npm run test:unit`, no backend):
  - parse: line → row mapping, comments/blanks ignored but preserved on write.
  - toggle: `*` prefix set/cleared, byte-faithful (CRLF/BOM/comments untouched).
  - reorder: single-row and multi-row (contiguous and non-contiguous selection) moves,
    byte-faithful.
- **Missing-master order-check unit tests**: master present-and-before → ok; master
  present-but-after → flagged; master absent → flagged; vanilla master present-and-before → ok
  (no special-casing needed, per Row model).
- **Load-order-derived master classification unit tests** (`MEditService.Tests/Query/MasterResolutionTests.cs`):
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
- **Composite seam**: `PluginsTreeComposite`'s own `getChildren`/`getTreeItem`/`setLoadOrder` —
  chevron transitions on mEdit start/stop, expansion gated on load order membership — tested
  against fake row/child providers (`src/test/PluginsTreeComposite.test.ts`), and the bounded-
  context boundary itself (`src/test/contextBoundary.test.ts`).
- **Record semantics and conflict classification** are the backend's responsibility and tested
  there (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.
- **Progressive-load seams.** The polling itself is `EditingController.putLoadOrder`
  with an `onProgress` callback and an `AbortSignal` — HTTP orchestration with no VS Code types,
  so cadence, tick reporting, poll-failure tolerance and the three outcomes (reconciled /
  failed / abandoned) are unit-tested with a fake client and fake timers. The incompleteness
  statement's text is a pure function (`medit/loadOrderProgress.ts`). What only a live window can
  show — chevrons appearing one plugin at a time, a mid-load failure decoration, master issues
  staying off until completion, `TreeView.message` appearing and clearing, and a mid-load close
  stopping the polling — is in the integration suite, whose mock backend **holds the load POST
  open** so the assertions land in the window that actually matters.
- **The view-header progress indicator (AC2) has no automated test.** `withProgress` returns
  nothing readable and leaves no observable state in the extension host — the same absence of a
  seam as `showCollapseAll` (modbench/CLAUDE.md title-bar rule 7). It is verified by reading the
  call sites (`makeEnterEditing`'s and `makeLoadOrderSync`'s `withPluginsViewProgress`, and that
  `modbench.modList.launchMedit` does not wrap the launch in a second indicator) and by
  `/manual-test` against a real load order. Recorded here as a known untested
  surface rather than covered by a test that would only restate the call.
- **Prior art**: `modlistText.test.ts`, `metaIni.test.ts`, `statusChecker.test.ts` — same
  fixture-in/value-out style; instance fixtures live under
  `modbench/src/modmanager/test/fixtures/`.
- **Integration seam** (`npm run test:integration`, real VS Code process): the tree renders from
  `plugins.txt` with no backend running; checkbox toggle, drag-reorder and the name filter round-trip
  with and without the backend running; starting/stopping the backend puts chevrons on and takes
  them off without disturbing the load order; navigation opens a record panel; a plugin
  `GET /plugins` reports with no matching records is hidden from the tree entirely,
  restored once a reconcile reports no filter at all rather than staying stuck hidden (the
  "map outlives the filter state" regression) — the pruning
  rule itself (record types and records pruned, a plugin row never removed by `GetPlugins()`
  itself) is backend-tested (`MEditService.Tests`), not re-proven here, since this suite's mock
  backend drives `GET /plugins` directly rather than through a real `POST /load-order/filter`; Reveal in
  Explorer dispatches; read failure renders the error tree node. Add new command id(s) to
  `EXPECTED_COMMANDS` (`modbench/CLAUDE.md`).

## Out of Scope

- **Auto-sort** (dependency-aware topological sort, LOOT parity) — deferred indefinitely; not
  scheduled, may become its own future initiative.
- **Cross-highlight with the Mods tree** on selection (MO2 parity) — deferred. Blocked by a
  confirmed VS Code
  API limitation (no programmatic multi-item selection, `FileDecoration` can't paint a full row
  background) rather than a priority call; the provisional approach when picked up is a
  `FileDecorationProvider` color/badge tint.
- **A "Mod" column** or any textual plugin→mod ownership display — deliberately dropped in
  favor of the (deferred) cross-highlight, matching MO2's implicit-link design rather than
  inventing a text column MO2 itself doesn't have.
- **Guard-railing vanilla/DLC/CC masters** against being disabled — deliberately not added;
  MO2 doesn't guard-rail it either, and the order-aware missing-master badge catches the
  fallout if it happens.
- **A structured conflict/EditorID/record-type filter UI** — filtering is deliberately
  user-written SQL against the generated per-type views, not a fixed toggle set (ADR-0018).
- **Multi-step form-space operations** — compact FormIDs, copy-as-underride (moving a record
  down into a master), and merge-into-another-plugin — are deferred and will be delivered as
  Python scripts over the header/renumber/delete edit primitives, not bespoke commands.
  They compose from those primitives and are inherently multi-step. Masters sort/clean/remove are
  not on this deferred list: per
  [ADR-0038](../adr/0038-masters-are-lifecycle-derived-never-user-declared.md), a plugin's masters
  are wholly derived from its content, never directly user-editable — so those never exist as a
  separate operation (scripted or otherwise) to defer in the first place. Near-term
  header editing (author, ESL/ESM flag) is a first-class feature — see User Story 24.
- **What the record editor does with a record once opened** —
  [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- **Glossary** — `CONTEXT.md` (Editing) and
  [modmanager `CONTEXT.md`](../../modbench/src/modmanager/CONTEXT.md) distinguish **Plugin
  load order** (this surface's subject, `plugins.txt`, record-level) from **Mod override order**
  (the Modlist, `modlist.txt`, file-level). [CONTEXT-MAP.md](../../CONTEXT-MAP.md)'s Mod-Management→Editing relationship
  description matches: the editing backend's plugin *order* comes from Plugin load order, not
  Modlist order (Modlist only resolves each plugin *name* to its winning physical file).
- **Filter box is a declared cross-surface convention**, not a per-surface bespoke choice: Mods
  tree, Downloads, and this surface all use `registerNameFilter`, which derives each view's two
  command ids and its filter-active context key from the view id so the three cannot drift into
  three conventions.
- The conflict badge and the Conflicts node: see *Conflicts node and conflict badge* above;
  the full visual encoding lives in [medit-record-editor.md](medit-record-editor.md).
