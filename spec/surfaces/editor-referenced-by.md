# Editor: Referenced By

Referenced By lists the records that reference a record, so I can see what a change to it would reach before I make it. Its template is xEdit's Referenced By tab ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md)); where it departs, [xedit.md](../out-of-scope/xedit.md) says why. Its gesture is `referenced by` in [commands.md](commands.md) under Record. The list shows in VS Code's References view, which behaves as VS Code made it ([common.md](common.md)).

Each story cites what decides it. A story that cites nothing is owned here.

## Asking

As a user, I want:

1. Referenced By in the menu of every record: a record row in Plugins, a column header in the record panel, and a row in this list. Cites: catalog `referenced by`; xEdit
2. Referenced By from the palette to ask about the record tab in focus, or, with none, to ask for a record with the record picker (editor-fields.md, References, story 1). Cites: catalog `referenced by`
3. The list in VS Code's References view, which takes the focus, titled `Referenced By: ` and the record's EditorID, or its FormKey when it has none. Cites: Existing tools
4. The list to be a snapshot of the moment I asked, which the view's refresh reads again. Cites: xedit.md, divergence 32
5. Referenced By on a row in the list to replace the list with that record's, and the view's history to keep the earlier list. Cites: xEdit; Existing tools
6. VS Code's tree Find to narrow the list. Cites: common.md; Existing tools
7. With VS Code's References view disabled, the gesture not offered. Cites: commands.md, No dead entries

## The tree

As a user, I want:

1. One row for each referrer of the record the list is about, however many plugins hold the reference: a referrer overridden in four plugins is one referrer, not four. Cites: xedit.md, divergence 15
2. Beneath a referrer, one row for each plugin that holds the reference, in plugin order: each is one plugin's copy of the referrer, as each row of xEdit's list is one file's record. Cites: xedit.md, divergence 15
3. Only active plugins to count: a reference held only in plugins that are not active lists nothing. Cites: ADR-0012
4. A reference counted only where its field is in use: a condition parameter its function does not use is not a reference, whatever it holds. Cites: xedit.md, divergence 13
5. A child record's references counted as its own: a quest and a dialog topic inside it each list what they reference.
6. The referrers sorted by record type, then by label.
7. Every referrer collapsed when the list shows.

## A row

### Referrer

| Part | What it shows | Cites |
|---|---|---|
| Label | as Plugins' record row labels it | [plugins.md](plugins.md), A row, Record |
| Description | the record type as xEdit names it, then `· 3 plugins` when more than one plugin holds the reference | xEdit's columns; ruling |
| Icon | none | |
| Tooltip | `EditorID [FormKey]`, the record type, and the plugins that hold the reference | |

### Where it is held

| Part | What it shows | Cites |
|---|---|---|
| Label | the plugin's file name | xEdit |
| Description | the fields that hold the reference | ruling |

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With a record nothing references, the message "No references found."
2. While mEdit is still indexing plugins, a message that the list may not be complete. Cites: Never silently wrong

## Menus and keys

A row is a record, so it offers what a record offers in Plugins ([plugins.md](plugins.md), Menus and keys). A referrer names no plugin.

| Where | Items, in order |
|---|---|
| Referrer menu | open · referenced by · copy value |
| Where it is held | the record menu of Plugins |
| Keys | none: VS Code's References view does not share its selection. |

As a user, I want:

1. A click on a referrer to open its winning copy as a preview editor. Cites: catalog `open`; editor.md, Opening, stories 1 and 8
2. A click on a row beneath a referrer to open that plugin's copy as a preview editor. Cites: catalog `open`; editor.md, Opening, story 1
3. Copy value to copy the row as `EditorID [FormKey]`. Cites: catalog `copy value`; plugins.md, Menus and keys, story 5
