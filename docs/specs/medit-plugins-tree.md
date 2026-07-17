# mEdit Plugins tree — Surface Specification

**Status: Implemented.**

Editing context — operates on **records**, **FormKeys**, and **plugins** (physical
`.esp`/`.esm`/`.esl` files loaded by the backend); the Mod-Management vocabulary ("mod",
"loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Record editor panel](medit-record-editor.md) (what this tree opens),
[Pending Changes tree](medit-pending-changes-tree.md),
[Referenced By panel](medit-referenced-by.md).

**Vocabulary note:** this "Plugins tree" is the entry point into per-record browsing and
requires a spawned backend. It is distinct from the Mod-Management **Plugin List**
([plugins.md](plugins.md)), which manages `plugins.txt` load order and runs without the
backend. Both display as "Plugins" but are distinct views (`modbench.pluginTree` vs
`modbench.pluginListTree`), visible in mutually exclusive view modes, and stay fully distinct
in code.

## Problem Statement

A mod author needs to find a record before they can do anything with it — and "find" means
several different questions. Which plugins are loaded? What does *this* plugin actually
declare, as opposed to what wins? Where does a record sit in the world? Which records conflict
and therefore need patching? Which records have I already touched? In xEdit these are answered
by one tree, and an author who has to leave the tree to answer any of them has lost the thread
of what they were doing.

The loadout is also too big to page through. A session spans hundreds of plugins and hundreds
of thousands of records, so any surface that only lists things — with no way to narrow by
name, by condition, or by position in the world — is unusable at the scale it must work at.

## Solution

A sidebar `TreeView` that is the **entry point for all navigation** in the mEdit view. It
browses each plugin's records by type, spatially by worldspace and cell, and by conflict — and
narrows on two independent axes: a plugin-name filter and a SQL record filter. Every path
through it ends at the [Record editor panel](medit-record-editor.md).

The session is constructed on entry from the active modlist's enabled plugins plus vanilla
masters; there is no separate load-session step.

## User Stories

1. As a user, I want a Plugins tree listing every loaded plugin as my entry point, so that all
   navigation starts from one place.
2. As a user, I want to select multiple tree nodes with Ctrl/Shift-click and run a batch
   action (e.g. Remove Record) across the whole selection, so that I can act on many records
   at once, even across different plugins.
3. As a user, I want a filter that narrows the top-level plugin nodes by filename as I type,
   so that I can find a plugin without scrolling — the same filter widget every other Modbench
   list surface uses.
4. As a user, I want to expand a plugin and see its record types, then its records (paginated,
   with a "Load more…" step), so that browsing a large plugin stays responsive.
5. As a user, I want each record labeled with its EditorID and FormKey (or just the FormKey
   when it has no EditorID), so that I can recognize records the way I do in xEdit.
6. As a user, I want vanilla, DLC, and immutable plugins marked with a lock icon and their
   editing actions hidden, so that I can't accidentally try to modify a read-only plugin.
7. As a user, I want a Conflicts node showing records that conflict across plugins, so that I
   can go straight to what needs patching.
8. As a user, I want a conflict badge overlaid on any record node that has a conflict or a lost
   change, so that I can spot trouble while browsing.
9. As a user, I want to browse a plugin's worldspaces and interior cells spatially — down
   through blocks, sub-blocks, cells, and their persistent/temporary placed references — so
   that I can navigate the world the way it's actually laid out, seeing only what *that* plugin
   declares rather than a cross-plugin winner.
10. As a user, I want to open a record by single-clicking its node, so that inspecting a record
    is immediate.
11. As a user, I want to filter the record tree by a SQL query against the backend's per-type
    tables (returning `form_key`), pruning plugins and record types with no matches, so that I
    can slice the loadout by any condition I can express (conflict status, EditorID search,
    record type) without a fixed toggle UI.
12. As a user, I want to save filters as `.sql` files, apply one from a picker or from an
    inline Code Lens on the file, and see which filter is active, so that my useful queries are
    reusable and obvious.
13. As a user, I want a built-in "pending changes" filter preset, so that I can immediately
    narrow the tree to records I've touched — this, not the Pending Changes tree, is how I
    browse my staged edits in context.
14. As a user, I want to create a new plugin, add a record to a plugin, copy a record as an
    override or as a new record into another plugin, and remove records (with a confirmation
    that lists everything selected), so that the common authoring operations are all in the
    tree.
15. As a user, I want to open a plugin's header as a first-class record by clicking the plugin
    node — viewing its author, masters, and flags in a single-column panel, and (on editable
    plugins) editing them through pending changes: set the author, toggle ESL/ESM (rejected at
    stage time when the plugin isn't ESL-eligible), and add a master chosen from the loaded
    plugins (validated so I can't make the plugin unloadable) — so that maintaining a plugin's
    header is staged and reviewable like any other edit.
16. As a user, I want to create and manage placed references (REFR/ACHR) inside a cell's
    persistent or temporary group, so that I can edit world placement spatially.

## Implementation Decisions

### The tree

- A `TreeView` (`modbench.pluginTree`, "Plugins"), visible while
  `modbench.viewMode == 'editing'`. It is the primary navigation surface; there is no separate
  load-session step — the session is constructed on entry from the active modlist's enabled
  plugins plus vanilla masters (`load-explicit`).
- **Multi-select** (`canSelectMany`): Ctrl/Shift-click selects multiple nodes, possibly
  spanning plugins and record types; batch-capable context commands (currently Remove Record)
  receive the full selection.
- **Plugin-name filter**: a title-bar magnifier opens a transient `InputBox` that live-filters
  the top-level plugin nodes by case-insensitive filename substring; dismissing it restores the
  full list. This is the shared cross-surface filter convention (Mods tree, Downloads, Plugin
  List, and here). It is a **distinct axis** from the record filter below: this narrows *which
  plugins* appear; the record filter narrows *which records* appear under a plugin. The two
  compose.
- **Top-level nodes**: one node per loaded plugin (children: Worldspaces + Interior Cells group
  nodes plus flat record-type nodes), and a lazy-counted **Conflicts** node listing conflict
  records. `WRLD`/`CELL`/`REFR`/`ACHR` are shown spatially (below) and hidden from the flat
  record-type list.
- **Plugin nodes**: labeled by filename, with a **lock icon on immutable plugins**. An **Open
  Header** action (context menu; also available inline) opens the plugin's **header record** —
  author, masters, flags — as a single-column record panel. Their context menu exposes New
  Plugin…, Copy as Override Into…, Open Header, and — on editable plugins only — Add New
  Record…, Convert to ESL/ESM, Add Master…, and Run Script…. Each is a confirmation or picker as
  appropriate; destructive ones confirm.
- **Record-type nodes**: labeled by type; children are paginated record nodes with a "Load
  more…" node at the end of a page.
- **Record nodes**: labeled `{EditorID}  [{RecordType}:{FormID}]` (FormKey only when no
  EditorID), with a conflict badge overlaid when the record conflicts or has a lost change (the
  underlying two-axis model is [ADR-0016](../adr/0016-two-axis-conflict-model.md); its visual
  encoding is specified in [medit-record-editor.md](medit-record-editor.md)). Single-click (or
  Open Record) opens the editor; the context menu adds Copy as Override Into…, Copy as New
  Record Into…, Remove Record (a confirmation listing every selected record, deleting the whole
  selection as one batch; the Delete key also triggers it), Show Referenced By, and Run Script…
  (context = this record).
- Context menu availability is driven by node `contextValue` from backend metadata:
  `"plugin"`, `"pluginImmutable"`, `"recordType"`, `"record"`.

### Record filter (SQL)

- The record tree is filtered by a **filter file** — a plain `.sql` file containing a DuckDB
  `SELECT` returning `form_key`. While active, the tree is pruned: plugins and record types
  with no matching records are hidden
  ([ADR-0018](../adr/0018-sql-file-based-record-filter.md)).
- Entry points: a tree title-bar funnel (opens a `setFilter` quick pick of `.sql` files in
  `modbench.scriptsPath` plus "New filter…"), a funnel-slash to clear (shown only while a
  filter is active), command-palette equivalents, and **Code Lens** on open `.sql` files under
  `modbench.scriptsPath` ("▶ Apply as Filter" when the file differs from the active filter; "✓
  Active — click to clear" when it is the active filter). A `filterActive` context key drives
  the active indicators.
- Conflict-status filtering, EditorID search, and record-type narrowing are all expressed as
  user-written SQL against the per-type DuckDB tables — **no structured toggle UI**. A built-in
  `pending-changes.sql` preset (`SELECT DISTINCT form_key FROM pending_changes`) is copied into
  `modbench.scriptsPath` on first use. That preset is how staged edits are browsed by plugin
  and record; the [Pending Changes tree](medit-pending-changes-tree.md) is organized by
  ChangeGroup and deliberately does not duplicate it (ADR-0029).

### Worldspace / interior-cell tree

- **Per-plugin**, under each plugin node: "Worldspaces" and "Interior Cells" group nodes show
  what *that plugin* declares (records and overrides), never a cross-plugin winner. Placed
  records (REFR/ACHR) are indexed; parentage lives in `placement` / `cell_location` side tables
  ([ADR-0023](../adr/0023-placed-objects-indexed-with-placement-side-tables.md)).
- The spatial hierarchy descends Worldspace → Block → Sub-block → Cell (by XCLC coordinates) →
  Persistent/Temporary placed-reference groups → placed references. Block and Sub-block nodes
  are grouping-only (no record, no click); clicking a CELL or REFR node opens the editor.
- Context menus: a **placed group** offers Create Placed… (quick pick REFR/ACHR + optional
  template FormKey); a **placed reference** offers Copy as Override Into… and Delete (the same
  handlers as elsewhere). CELL nodes have no menu.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — observe the tree
  through `getChildren` / `getTreeItem` against a stubbed repository: given a session, assert
  the node shape, labels, `contextValue`s, and pagination; given an active filter, assert what
  is pruned. Never construct nodes directly.
- **Seam**: `PluginTreeProvider` takes a `PluginRepository`, not an `ApiClient` — unit-tested
  without VS Code (Vitest, `npm run test:unit`). New data queries go on the `PluginRepository`
  interface and are implemented in `ApiPluginRepository`.
- **Record semantics and conflict classification** are the backend's responsibility and tested
  there (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.
- **Integration seam** (`npm run test:integration`, real VS Code process): the tree builds from
  a session, navigation opens a record panel, the record filter prunes the tree, and command
  registration holds — add any new command id(s) to `EXPECTED_COMMANDS`.
- Per `modbench/CLAUDE.md`: a failed fetch yields an **error tree node**, never an empty list.

## Out of Scope

- **A structured conflict/EditorID/record-type filter UI** — filtering is deliberately
  user-written SQL against the per-type tables, not a fixed toggle set (ADR-0018).
- **Multi-step form-space operations** — compact FormIDs, copy-as-underride (moving a record
  down into a master), merge-into-another-plugin, and sort/clean/remove masters — are deferred
  and will be delivered as Python scripts over the header/renumber/copy/delete staging
  primitives, not bespoke commands. They compose from those primitives and are inherently
  multi-step (a masters reorder remaps every FormID's master index; clean requires whole-plugin
  reference analysis). Near-term header editing (author, ESL/ESM flag, add master) is a
  first-class feature — see User Story 15.
- **Load-order editing** — that is the Mod-Management Plugin List ([plugins.md](plugins.md)), a
  different surface in a different bounded context.
- **What the record editor does with a record once opened** —
  [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- The conflict badge on a record node is the tree's only use of the two-axis conflict model;
  the full ConflictAll/ConflictThis visual encoding lives in
  [medit-record-editor.md](medit-record-editor.md), and the classification itself is computed
  backend-side (ADR-0016).
