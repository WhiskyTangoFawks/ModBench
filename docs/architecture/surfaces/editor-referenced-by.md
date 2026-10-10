# Editor: Referenced By

Referenced By lists the records that reference a record, so I can see what a change to it would reach before I make it. Its template is xEdit's Referenced By tab ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)); where it departs, [xedit.md](../../out-of-scope/xedit.md) says why. Its gesture is `referenced by` in [commands.md](../commands.md) under Record. The list shows in VS Code's References view, which gives its history, navigation, Find, refresh and clear. It is a list, so [common.md](common.md) applies to it, except where a story here names an exception.

Each story cites its source. A story with no source is owned here.

## Asking

As a user, I want:

1. Referenced By in the menu of every record: a record row in Plugins, a column header in the record panel, and a row in this list. Source: catalog `referenced by`; xEdit
2. Referenced By from the palette to ask about the record tab in focus, or, with none, to ask for a record with the record picker. Source: catalog `referenced by`
3. The list in VS Code's References view, which takes the focus, titled `Referenced By: ` and the record's EditorID, or its FormKey when it has none. Source: Existing tools
4. The list to be a snapshot of the moment I asked, which the view's refresh reads again. This is an exception to common.md, A view, story 2: a snapshot is true when it is taken, and I know it is one. Source: ruling
5. Referenced By on a row in the list to replace the list with that record's, and the view's history to keep the earlier list. Source: xEdit; Existing tools
6. VS Code's tree Find to narrow the list. This is an exception to common.md, The name filter, and A view, story 7: the view is VS Code's, and Modbench adds nothing to its title bar. Source: Existing tools
7. With VS Code's References view disabled, the gesture refused, naming the built-in extension it needs. Source: common.md, Reporting

## The tree

As a user, I want:

1. One row for each referrer of the record the list is about, however many plugins hold the reference: a referrer overridden in four plugins is one referrer, not four. Source: xedit.md, divergence 15
2. Beneath a referrer, one row for each plugin that holds the reference, in plugin order: each is one plugin's copy of the referrer, as each row of xEdit's list is one file's record. Source: xedit.md, divergence 15
3. Only active plugins to count: a reference held only in plugins that are not active lists nothing. Source: ADR-0012
4. A reference counted only where its field is in use: a condition parameter its function does not use is not a reference, whatever it holds. Source: xedit.md, divergence 13
5. A child record's references counted as its own: a quest and a dialog topic inside it each list what they reference.
6. The referrers sorted by record type, then by label.
7. Every referrer collapsed when the list shows.

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

1. With a record nothing references, the message "No references found."
2. While mEdit is still indexing plugins, a message that the list may not be complete. Source: Never silently wrong

## Menus and keys

A row is a record, so it offers what a record offers in Plugins ([plugins.md](plugins.md), Menus and keys). A referrer names no plugin.

| Where | Items, in order |
|---|---|
| Referrer menu | open to the side · referenced by · copy value |
| Where it is held | the record menu of Plugins |
| Keys | as on a record row in Plugins. Delete acts only on a row beneath a referrer. |

As a user, I want:

1. A click on a referrer to open its winning copy as a preview editor. Source: catalog `open`; editor.md, Opening, stories 1 and 8
2. A click on a row beneath a referrer to open that plugin's copy as a preview editor. Source: catalog `open`; editor.md, Opening, story 1
3. Copy value to copy each selected row as `EditorID [FormKey]`. Source: catalog `copy value`; plugins.md, Menus and keys, story 5

## Test seam

- The list, given the record it is about and mEdit's answer: the title, the rows, their order, and the states, with no VS Code UI.
- Asking: given the clicked record, or the record tab in focus, or neither, the record the list is about.
- A gesture's entry: given the clicked row and the selection, the Argument the command receives, and what copy value copies.
- Menus and keys: the placement above, checked against the extension manifest.
