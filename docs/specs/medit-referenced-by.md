# mEdit Referenced By tree — Surface Specification

**Status: Implemented.** A native `TreeView` in a Panel view that follows the active
record editor, matching xEdit's own placement and lifecycle for this surface.

Editing context — operates on **records**, **FormKeys**, and **plugins**; the Mod-Management
vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared load order lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Plugins tree](plugins.md) (a record node's own context menu, no longer this tree's
entry point — see below), [Record editor panel](medit-record-editor.md) (the active record this
tree follows, and what a referrer opens into).

## Problem Statement

Records point at each other. A weapon names a keyword, an NPC names an outfit, a container
names its contents — all by FormLink. The compare grid shows what a record points *at*; it
cannot show what points *back*. So a mod author about to change or remove a record has no way
to see what they are about to break, and finds out when the game does.

The question is also noisier than it looks. A single referencing record may be overridden in
several plugins, and listing each override separately buries the answer — "one record refers to
this, in four plugins" reads as four problems when it is one.

## Solution

A native `TreeView`, listing every record that holds a FormLink to the current one, **grouped by
the referencing record** so that multiple plugin overrides of the same referencer collapse into a
single entry. Every group is a navigation target, so tracing a reference chain is clicking.

Per [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md), this surface
follows xEdit's own answer for where "Referenced By" lives: xEdit puts it in a tab beside the
record view (`View`, `Messages`, `Referenced By`), not in the navigation pane, and it is never
invoked — it simply reflects whatever record is currently selected, carrying its own referrer
count in its caption (`Referenced By (%d)`). mEdit's nearest native analogue to "a tab beside the
record view" is the **Panel container** (the one hosting Problems/Output/Terminal/Debug Console),
directly under the editor group it describes. The view **retargets automatically** on the active
record editor — no command opens or aims it — and its title carries the same `Referenced By (N)`
count xEdit's caption does.

One deliberate divergence from xEdit: the view **never hides**. xEdit's tab disappears when the
selected record has no referrers (`tbsReferencedBy.TabVisible := ... lvReferencedBy.Tag > 0`), but
panel views in VS Code do not appear and disappear — Problems stays put at zero — and flickering a
view in and out of the panel on every selection change would be jarring and unlike any native VS
Code surface. Zero referrers renders the tree's own empty state instead.

## User Stories

1. As a user, I want a "Referenced By" view listing every record that points a FormLink at the
   one I'm looking at, so that I can see what would break if I changed or removed it.
2. As a user, I want multiple plugin overrides of the same referencing record collapsed into
   one entry, so that one referencer reads as one thing rather than as several.
3. As a user, I want to see which plugins hold each reference and at which field path, so that
   I know where the reference actually lives.
4. As a user, I want to open a referencing record from that tree — in the active pane or
   beside it — so that I can trace a reference chain quickly.
5. As a user, I want the view to follow whatever record I'm currently looking at automatically,
   so that I never have to ask for it or retarget it myself.
6. As a user, I want to be told when nothing references this record, so that "no references" is
   an answer rather than an ambiguous blank.
7. As a user, I want to select several referrers at once and copy them, so that I can paste a
   list of what references this record somewhere else (an issue, a changelog, a chat).

## Implementation Decisions

- A native `TreeView` (`modbench.referencedByTree`, declared name **"Plugins - Referenced By"** —
  the `Plugins - …` prefix is the
  naming convention for a sub-functionality of the Plugins tree, since VS Code has no view
  nesting/grouping within a container to say so structurally; referred to here by its short name
  for readability), contributed to its own Panel-location `viewsContainers` entry
  (`modbenchReferencedBy`) rather than stacked under the `modbench` activity-bar container with
  the Plugins tree — a per-record relationship query is not the always-relevant load order state
  that tree is, and Panel placement is VS Code's own answer to "a tab beside the thing it
  describes." **Carries no gate at all** — always present, exactly like Mods/Plugins/Downloads;
  there is no view mode and no visibility context key. The consequence is
  deliberate, not an oversight: with no backend running and no active record, the view still renders —
  its own empty state (`NoActiveRecordNode`, "Open a record to see what references it.") covers
  it, the same way it already covers "a record is active but has zero referrers." No fetch is
  attempted until `ActiveRecordTracker` actually reports a FormKey, which cannot happen without a
  load order, so an idle Referenced By panel costs nothing.
- **Retargeting is driven by `ActiveRecordTracker`** (`src/medit/ActiveRecordTracker.ts`), not by
  a command argument. `openRecordPanel` (the record editor's own panel-open/reuse/retarget choke
  point) reports each panel's currently displayed FormKey and which panel is active; the tracker
  fires the *active* panel's FormKey on either change, and `ReferencedByTreeProvider.showFor`
  subscribes to that once, in `activate()`. This is forward-compatible with several
  independent record editors (planned) — the tracker already resolves "whichever panel is active," not "the
  one singleton panel". `showFor(undefined)` (no
  record panel open, or the active one hasn't loaded a record yet) renders `NoActiveRecordNode`
  ("Open a record to see what references it.").
- `modbench.showReferencedBy` **still exists but no longer retargets anything** — it degrades to a
  `modbench.referencedByTree.focus` convenience (Command Palette only). It is not on any
  right-click menu: the record-row context-menu entry that used to invoke it is deleted outright,
  not just left unused, because leaving it would strand a menu item with nothing left for it to
  aim.
- It lists records holding a FormLink to this record, **grouped by FormKey** so that multiple
  plugin overrides of the same referencer collapse into one group (`ReferencedByGroupNode`). A
  group's label is `{RecordType} / {EditorID ?? FormKey}` with a `{N} plugins` description
  (omitted when one); selecting it (the node's `command`) opens that record in the active pane.
  Right-click (`referencedByGroup` contextValue) offers **Open**, **Open to the Side** (via
  `modbench.openEditorBeside`), and **Copy**. Expanded child rows (`ReferencedByFieldNode`) show
  each holding plugin and field path — no `command`, informational only.
- **The view title carries the referrer count** — `Referenced By (N)`, matching xEdit's own
  caption format — driven by a constructor callback on `ReferencedByTreeProvider`
  (`onCountChanged`), fired every time its root query resolves. `N` is the number of *groups*,
  not the raw reference
  row count. The title omits the count (bare `"Referenced By"`) whenever it isn't a known
  quantity — no active record, or a failed fetch — rather than ever showing a `(0)` that isn't
  actually a confirmed zero-referrer result.
- **Multi-selection and copy.** The
  view is created with `canSelectMany: true`, same as the Plugins tree.
  `modbench.referencedByTree.copy` is reachable by a `Ctrl+C` keybinding (`focusedView ==
  modbench.referencedByTree`) *and* a `view/item/context` entry — both invoking the one command,
  the same shape `modbench.deleteRecord` already uses elsewhere in this tree family.
  [ADR-0034](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md)'s "no action reachable
  two ways" is about redundant *affordances* for one action (an inline button duplicating a menu
  item), not a command carrying both a keybinding and a menu entry — those are the same route, not
  two. **The group node is the copyable unit; field rows are detail** — `referencedByCopyText`
  filters a selection down to `ReferencedByGroupNode`s only, so a field row mixed into a
  multi-selection contributes nothing and a selection of field rows alone copies empty text. Each
  copied line is that group's own **label** — exactly `{RecordType} / {EditorID ?? FormKey}`, the
  referrer's identity. This is deliberately narrower than the row's full displayed text: a group
  referenced from more than one plugin also shows a `{N} plugins` `.description`, and that count
  is dropped from the copied line — it annotates the row, it doesn't identify the referrer, and a
  paste target (an issue, a changelog, a chat) wants the identity, not a count with no plugin names
  attached to it. The write itself goes through the extension host
  (`vscode.env.clipboard.writeText`), never the (nonexistent, for this surface) webview — the
  record editor's own precedent, [ADR-0034 divergence
  #3](../adr/0034-xedit-is-the-ux-reference-for-the-record-editor.md#permitted-divergences-and-why-each-is-forced) —
  with the same catch-log-surface treatment `COPY_TO_CLIPBOARD` already uses
  ([ADR-0026](../adr/0026-error-surfacing-policy.md)).
- Empty state: "No references found." A **failed fetch** yields an error node
  (`ErrorNode`, "Failed to load references."), never the empty state — the same
  fetch-failure-is-not-empty convention every tree in this product follows
  ([ADR-0026](../adr/0026-error-surfacing-policy.md)).
- Reference data comes from the backend (`GET /records/{formKey}/references`) through the
  generated `ApiClient`, never raw `fetch()`; this surface renders it and does not derive it.

## Actionable-menu decision

xEdit's own right-click menu on this surface (`pmuRefBy`) is fully mutating: Compare Selected,
the whole Copy-as-override/Copy-as-new-record/Deep-copy family, Remove, Mark Modified, Visible
When Distant. mEdit's version is **deliberately narrower — selection and copy, mutation
deferred**, and that narrowing is a recorded decision, not an omission:

- **Selection and non-mutating copy are in scope and shipped** — multi-select
  (`canSelectMany`), Copy (a selected group's own label), Open, and Open to the Side. None of
  these mutate a record, so they don't trip the "tree navigates, it does not mutate" line below.
- **The mutating family (the copy-as-override/copy-as-new-record group, Remove, Mark Modified,
  Visible When Distant) is deferred to the planned unified record context menu**, not rejected.
  That work unifies one record context menu
  across the record row, the placed-record row, and the record editor's column header — Referenced
  By rows are records too, so they become a fourth surface for that same shared menu. Building the
  mutating family here first would mean building it a fourth time immediately before the
  unification removes the duplication.
- **Compare Selected is deferred until multi-record compare exists**, which this surface would
  need and does not yet have.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — for this surface that
  means observing the tree through `getChildren`/`getTreeItem` against a stubbed `ApiClient`:
  given a references response, assert the rendered grouping (one group per referencing FormKey,
  plugin count shown only when more than one), the field rows, that a group's `command` targets
  the right FormKey, and the `onCountChanged` callback's reported count (a known number only on a
  resolved fetch; `undefined` when idle or failed). Never construct nodes directly to assert tree
  *structure* — `referencedByCopyText`'s own tests are the one deliberate exception, since its
  contract genuinely is "given these nodes, produce this text," and real nodes obtained from the
  provider are used as that function's input rather than hand-built ones.
- **Seam**: the tree provider's public surface against a stubbed `ApiClient` — Vitest,
  `npm run test:unit`, no backend and no VS Code.
- **`ActiveRecordTracker`** is tested on its own public surface (`setFormKey`/`setActivePanel`/
  `removePanel`/`current`/`onDidChangeActiveRecord`) with opaque panel-identity tokens — no
  `vscode.WebviewPanel` and no VS Code harness, since the class never reads
  `.active`/`.onDidChangeViewState` itself (that's `extension.ts`'s glue, exercised only by the
  integration harness registering the expected commands).
- **Which records reference which** is the backend's responsibility and is tested there
  (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.
- **Manifest assertions**: `src/test/packageJson.test.ts` asserts the view's container placement
  (present in a `viewsContainers.panel`-listed container, absent from `modbench`'s own view list)
  and, as this repo's existing convention for a subtractive manifest change, that
  `modbench.showReferencedBy` appears in **no** `contributes.menus` entry anywhere — the removal
  acceptance criterion, asserted the same way `packageJson.test.ts` already asserts other
  manifest removals (e.g. the retired `modbench.mods.launchCommand` setting).
- **Integration seam** (`npm run test:integration`): command registration only
  (`modbench.openEditorBeside`, `modbench.referencedByTree.copy` in `EXPECTED_COMMANDS`) — the
  view's container placement, `when`-clauses, and context-menu wiring are package.json declaration,
  checked by `packageJson.test.ts` above rather than this harness.

## Out of Scope

- **Mutating actions from xEdit's `pmuRefBy`** — the copy-as-override/copy-as-new-record family,
  Remove, Mark Modified, Visible When Distant — deferred to the unified record context menu (see
  "Actionable-menu decision" above), not rejected.
- **Compare Selected** — needs multi-record compare, unbuilt.
- **Multi-record referrer unions** — showing the union of referrers for a multi-record *source*
  selection (as opposed to multi-selecting *referrer* rows, which is in scope and shipped) needs a
  batch `GET /records/{formKeys}/references`-style endpoint; today's endpoint is single-FormKey,
  so an N-record selection would be N round trips. The grouping model already supports the result
  shape (collapse-by-FormKey over a larger input) — only the backend call is missing.
- **Reference validation at edit time** — that is a backend concern (ADR-0041: FormLinks
  validate at edit time), surfaced by whichever command made the edit, not
  here.
- **A referrer whose only link lives inside a VMAD struct-list script property** — Mutagen's own
  `ScriptStructListProperty.EnumerateFormLinks` does not walk `Structs[*].Members`
  (Mutagen-Modding/Mutagen upstream issue 688), so this tree cannot list that referrer; the backend's own read
  (`GetReferencedBy`) has the identical gap Track/Compile refuse on
  (`docs/specs/medit-repair.md`'s Kind A table). Blocked upstream, not patched here — hand-walking
  struct members to recover these links would be a second, divergent link enumerator alongside
  whatever `EnumerateFormLinks` becomes once the upstream fix lands, which is exactly the risk
  that refusal rejected.
- **Forward references** (what this record points at) — that is the compare grid's FormKey
  cells, [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- Grouping by referencing record, rather than by holding plugin, is what makes the tree answer
  "what breaks" rather than "how many rows are there". The plugin list is detail under the
  answer, not the answer.
- **Always-present-and-following, not invoked-and-retargeted**, is the deliberate choice here:
  xEdit users never look for a "show
  Referenced By" command because there isn't one — the pane is simply there, next to the record,
  whenever it has something to say. The native Panel
  placement makes "beside the record view" reachable without a webview.
