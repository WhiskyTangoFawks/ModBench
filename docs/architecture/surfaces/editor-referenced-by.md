# Editor: Referenced By

Referenced By lists the records that reference the record I am looking at, so I can see what a
change to it would reach before I make it. Its template is xEdit's Referenced By tab
([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)); where it departs,
[xedit.md](../../out-of-scope/xedit.md) says why. Its gestures are in
[commands.md](../commands.md) under Record. It is a list, so [common.md](common.md) applies to it
in full. The record panel it follows is [editor.md](editor.md)'s.

Each story cites its source. A story with no source is owned here.

## The view

A native tree view in the Panel, beside Problems and Output, in its own container
`modbenchReferencedBy`, and named "Referenced By". It is always there and never hides. *commands.md,
Where surfaces live*

As a user, I want:

1. The list to follow the record tab I am in, with no gesture of mine: xEdit's tab follows the
   selected record, and nothing aims it. *catalog `show referenced by`; xEdit*
2. When I move to a tab that is not a record, the list to keep the last record. When I close the
   last record tab, the list to empty.
3. The title to count the records that reference it, as xEdit's tab caption does: `Referenced By
   (12)`. With no record, or while the count is not known, the title has no count, so it never
   shows a zero it has not confirmed. *xEdit; ruling*
4. The description to name the record the list is about, then the name filter's term while one is
   active: `WeapLaserGun · "arm"`. *common, The name filter, story 5*
5. Several rows selected at once, and a gesture to act on the whole selection. *common, A view,
   story 6*

## The tree

As a user, I want:

1. One row for each record that references the active one, however many plugins hold the
   reference: a referrer overridden in four plugins is one referrer, not four. *ruling*
2. Beneath a referrer, one row for each plugin that holds the reference, in plugin order: each is
   one plugin's copy of the referrer, as each row of xEdit's list is one file's record. *xEdit*
3. Only the plugins the game loads to count: a reference held only in a disabled plugin, or in an
   overridden plugin, lists nothing and counts toward nothing. *ADR-0013, invariant 3; ruling*
4. A reference counted only where its field is in use: a condition parameter its function does not
   use is not a reference, whatever it holds. *xedit.md, divergence 15*
5. A child record's references counted as its own: a quest and a dialog topic inside it each list
   what they reference. *ruling*
6. The referrers sorted by record type, then by label, and the title bar's toggle to reverse them.
   *common, A view, story 7*
7. Every referrer collapsed when the list follows a new record.

## A row

### Referrer

| Part | What it shows | Source |
|---|---|---|
| Label | the EditorID, or the FormKey when it has none | Plugins' record row |
| Description | the record type as xEdit names it, then `· 3 plugins` when more than one plugin holds the reference | xEdit's columns; ruling |
| Icon | none | Plugins' record row |
| Tooltip | `EditorID [FormKey]`, the record type, and the plugins that hold the reference | |
| Identity | the referrer's FormKey | |

### Where it is held

| Part | What it shows | Source |
|---|---|---|
| Label | the plugin's file name | xEdit |
| Description | the fields that hold the reference, as mEdit gives their paths, joined by `, ` | ruling; mEdit's answer |
| Identity | the referrer's FormKey and the plugin | |

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no record open, the message "Open a record to see what references it." *ruling*
2. With a record nothing references, the message "No references found." *ruling*
3. While mEdit is still indexing plugins, a message that the list may not be complete. *ADR-0019,
   invariant 1*
4. The list to read again when mEdit reports a change to the records, from an edit of mine or from
   any other tool. *ADR-0015, invariant 3*

## Menus and keys

The row menus follow VS Code's groups: open, change, copy, then destroy.

| Where | Items, in order |
|---|---|
| Title bar | 1: filter, or clear filter while active. 2: sort direction. Collapse All last. |
| Referrer menu | open to the side · copy value |
| Where it is held | copy… · delete |
| Keys | Enter: open, as a click does. Ctrl+C: copy value. Delete: delete, on a row beneath a referrer. |

As a user, I want:

1. A click on a referrer to open it in the record panel's preview tab, which moves the list to it,
   so following a chain of references is a series of clicks. *catalog `open`; xEdit*
2. A click on a row beneath a referrer to select it and do nothing else.
3. Copy value to copy each selected referrer as `EditorID [FormKey]`, one to a line. A row beneath a
   referrer adds nothing. *catalog `copy value`; [editor-fields.md](editor-fields.md)*
4. Copy and delete on the selected rows beneath a referrer, each acting on that plugin's copy, as in
   Plugins. *catalog `copy`, `delete`; xEdit's Referenced By menu*

## Deferred

| What | Waits on |
|---|---|
| What references several records at once | a query over several records |
| Comparing the selected referrers | #23 |
| References from record types mEdit does not index, such as landscape and navmesh | their indexing |

## Test seam

- **The view, given the active record and mEdit's answer:** the title, the description, the rows,
  their order in both directions, and the states, with no VS Code UI.
- **Following:** given a sequence of focused tabs, opened and closed, the record the list is about.
- **A gesture's entry:** given the clicked row and the selection, the Argument the command receives,
  and what copy value copies.
- **Menus and keys:** the placement above, checked against the extension manifest.
