# mEdit Referenced By tree — Surface Specification

**Status: Implemented.** #213 migrated this surface off a hand-rolled webview tree onto a native
`TreeView`, the same model the Pending Changes tree already used.

Editing context — operates on **records**, **FormKeys**, and **plugins**; the Mod-Management
vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Plugins tree](medit-plugins-tree.md) (where this tree is invoked from, via a record node's Show
Referenced By), [Record editor panel](medit-record-editor.md) (what this tree navigates to),
[Pending Changes tree](medit-pending-changes-tree.md) (the structural model this tree mirrors —
`TreeDataProvider`, typed node classes, the `ErrorNode`/empty-state convention).

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

It is an **on-demand, per-record relationship query**, not an always-relevant overview like the
Plugins or Pending Changes trees — the same shape as VS Code's own Call Hierarchy / Type
Hierarchy views: hidden until first invoked from a specific record, then retargeted in place by
every subsequent invocation rather than recreated. It lives in the sidebar, alongside the record
editor by nature of VS Code's layout, so the point of reading it *while* looking at the record it
describes survives the move off a `ViewColumn.Beside` webview.

## User Stories

1. As a user, I want a "Referenced By" tree listing every record that points a FormLink at this
   one, so that I can see what would break if I changed or removed this record.
2. As a user, I want multiple plugin overrides of the same referencing record collapsed into
   one entry, so that one referencer reads as one thing rather than as several.
3. As a user, I want to see which plugins hold each reference and at which field path, so that
   I know where the reference actually lives.
4. As a user, I want to open a referencing record from that tree — in the active pane or
   beside it — so that I can trace a reference chain quickly.
5. As a user, I want the tree to stay out of the sidebar until I ask for it, so that it does not
   clutter an always-relevant view with a query result for one record.
6. As a user, I want to be told when nothing references this record, so that "no references" is
   an answer rather than an ambiguous blank.

## Implementation Decisions

- A native `TreeView` (`modbench.referencedByTree`, "Referenced By"), stacked in the `modbench`
  container below Pending Changes but gated on its own context key
  (`modbench.referencedByShown`) rather than `modbench.viewMode` alone — so it is contributed
  but invisible until the first `modbench.showReferencedBy` invocation sets that key and
  `.focus()`s the view. A later invocation on a different record retargets the same view
  (`ReferencedByTreeProvider.showFor`) rather than re-triggering the hide/reveal dance.
- It lists records holding a FormLink to this record, **grouped by FormKey** so that multiple
  plugin overrides of the same referencer collapse into one group (`ReferencedByGroupNode`). A
  group's label is `{RecordType} / {EditorID ?? FormKey}` with a `{N} plugins` description
  (omitted when one); selecting it (the node's `command`) opens that record in the active pane.
  Right-click (`referencedByGroup` contextValue) offers **Open** and **Open to the Side** as
  named context-menu actions (ADR-0033) — the latter via the new `modbench.openEditorBeside`
  command, replacing the old webview's undocumented right-click-opens-beside gesture. Expanded
  child rows (`ReferencedByFieldNode`) show each holding plugin and field path — no `command`,
  informational only.
- Empty state: "No references found." A **failed fetch** yields an error node
  (`ErrorNode`, "Failed to load references."), never the empty state — same convention as the
  Pending Changes tree ([ADR-0026](../adr/0026-error-surfacing-policy.md)).
- Reference data comes from the backend (`GET /records/{formKey}/references`) through the
  generated `ApiClient`, never raw `fetch()`; this surface renders it and does not derive it.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — for this surface that
  means observing the tree through `getChildren`/`getTreeItem` against a stubbed `ApiClient`:
  given a references response, assert the rendered grouping (one group per referencing FormKey,
  plugin count shown only when more than one), the field rows, and that a group's `command`
  targets the right FormKey. Never construct nodes directly and never assert node internals.
- **Seam**: the tree provider's public surface against a stubbed `ApiClient` — Vitest,
  `npm run test:unit`, no backend and no VS Code. Same seam as the Pending Changes tree's own
  test.
- **Which records reference which** is the backend's responsibility and is tested there
  (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.
- **Integration seam** (`npm run test:integration`): command registration only
  (`modbench.openEditorBeside` in `EXPECTED_COMMANDS`) — the view's hide/reveal and context-menu
  wiring is `when`-clause/package.json declaration, not exercised by this harness.

## Out of Scope

- **Editing from this tree** — child rows are informational; the tree navigates, it does not
  mutate.
- **Reference validation at stage time** — that is a backend concern
  ([ADR-0020](../adr/0020-reference-validation-at-stage-time.md)), surfaced by whichever
  command staged the change, not here.
- **Forward references** (what this record points at) — that is the compare grid's FormKey
  cells, [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- Grouping by referencing record, rather than by holding plugin, is what makes the tree answer
  "what breaks" rather than "how many rows are there". The plugin list is detail under the
  answer, not the answer.
- Hidden-until-invoked (rather than an always-visible third stacked tree, the Plugins/Pending
  Changes pattern) is the deliberate choice here: Referenced By answers a question about one
  record, asked once, not an always-current state of the whole session — closer to Call
  Hierarchy than to a sidebar fixture.
