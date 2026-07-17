# mEdit Referenced By panel — Surface Specification

**Status: Implemented.**

Editing context — operates on **records**, **FormKeys**, and **plugins**; the Mod-Management
vocabulary ("mod", "loadout", "deploy") belongs to the sibling surfaces, not here
([CONTEXT-MAP.md](../../CONTEXT-MAP.md), glossary: [CONTEXT.md](../../CONTEXT.md)).

One of the mEdit view's surfaces — see [medit.md](medit.md) for the shared session lifecycle,
status bar, command palette, and architecture seams. Siblings:
[Plugins tree](medit-plugins-tree.md) (one of the two places this panel opens from),
[Record editor panel](medit-record-editor.md) (the other, and what this panel navigates to),
[Pending Changes tree](medit-pending-changes-tree.md).

## Problem Statement

Records point at each other. A weapon names a keyword, an NPC names an outfit, a container
names its contents — all by FormLink. The compare grid shows what a record points *at*; it
cannot show what points *back*. So a mod author about to change or remove a record has no way
to see what they are about to break, and finds out when the game does.

The question is also noisier than it looks. A single referencing record may be overridden in
several plugins, and listing each override separately buries the answer — "one record refers to
this, in four plugins" reads as four problems when it is one.

## Solution

A **separate** webview panel opened beside the record editor, listing every record that holds a
FormLink to the current one, **grouped by the referencing record** so that multiple plugin
overrides of the same referencer collapse into a single entry. Every entry is a navigation
target, so tracing a reference chain is clicking.

It is deliberately not a tab inside the record editor: the point is to read it *while* looking
at the record it describes.

## User Stories

1. As a user, I want a "Referenced By" panel listing every record that points a FormLink at
   this one, so that I can see what would break if I changed or removed this record.
2. As a user, I want multiple plugin overrides of the same referencing record collapsed into
   one entry, so that one referencer reads as one thing rather than as several.
3. As a user, I want to see which plugins hold each reference and at which field path, so that
   I know where the reference actually lives.
4. As a user, I want to open a referencing record from that panel — in the active pane or
   beside it — so that I can trace a reference chain quickly.
5. As a user, I want the panel open alongside the record it describes rather than in front of
   it, so that I can read both at once.
6. As a user, I want to be told when nothing references this record, so that "no references" is
   an answer rather than an ambiguous blank.

## Implementation Decisions

- A **separate** webview panel (not a tab in the record editor), titled
  `"Referenced By: {EditorID}"` (or FormKey), opened from a record node's Show Referenced By or
  a header button, alongside the record panel (`ViewColumn.Beside`). It lazy-loads its
  references only when first opened.
- It lists records holding a FormLink to this record, **grouped by (FormKey, RecordType)** so
  that multiple plugin overrides of the same referencer collapse into one group. A group header
  shows `{RecordType} / {EditorID}` and a plugin count (omitted when one); left-click opens that
  record in the active pane, right-click offers "Open to the Side". Expanded child rows show
  each holding plugin and field path (informational, not clickable).
- Empty state: "No references found."
- Reference data comes from the backend (`GET /records/{formKey}/references`); this surface
  renders it and does not derive it.

## Testing Decisions

- **Good tests assert external behavior, not implementation details** — given a references
  response, assert the rendered grouping (one group per referencing FormKey, plugin count
  shown only when more than one), the child rows, and that opening a group issues the right
  navigation. No assertions about private component internals.
- **Seam**: the webview React component through its props, with the injected typed client —
  Vitest, `npm run test:unit`, no backend and no VS Code. Colocated test, the established
  sibling-component pattern.
- **Which records reference which** is the backend's responsibility and is tested there
  (`MEditService/CLAUDE.md`); this surface consumes representative responses as fixtures.

## Out of Scope

- **Editing from this panel** — child rows are informational; the panel navigates, it does not
  mutate.
- **Reference validation at stage time** — that is a backend concern
  ([ADR-0020](../adr/0020-reference-validation-at-stage-time.md)), surfaced by whichever
  command staged the change, not here.
- **Forward references** (what this record points at) — that is the compare grid's FormKey
  cells, [medit-record-editor.md](medit-record-editor.md).

## Further Notes

- Grouping by referencing record, rather than by holding plugin, is what makes the panel answer
  "what breaks" rather than "how many rows are there". The plugin list is detail under the
  answer, not the answer.
