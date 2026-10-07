# Editor: the record panel

The record panel shows a record as its file, with every active plugin's copy beside it: a row for each field, a column for each copy. Opened on several records, it shows them side by side instead. Its template is xEdit's View grid ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)); where it departs, [xedit.md](../../out-of-scope/xedit.md) says why. Its gestures are in [commands.md](../commands.md) under Record, Plugin, Mod (`track`) and Every view.

The Editor surface has three more files:

- [editor-fields.md](editor-fields.md): how each field reads and edits, type by type.
- [editor-conflicts.md](editor-conflicts.md): the colours of a record order conflict.
- [editor-referenced-by.md](editor-referenced-by.md): the Referenced By view.

The panel is a grid, not a list, so the list rules in [common.md](common.md) do not apply to it. Its States, A gesture that writes and Reporting do.

Each story cites its source. A story with no source is owned here.

## Opening

The record tab is VS Code's editor for the record's file ([ADR-0001](../../adr/0001-modbench-is-a-vscode-extension.md)). Preview, pinning, Go Back and Go Forward, the recent editors, reopening a closed tab, restoring the tabs after a reload, Quick Open, search results, the Source Control view and the Timeline reach it as they reach any file. Source: VS Code; Existing tools

As a user, I want:

1. A click on a record in Plugins or Referenced By to open it as a preview editor, which my next click replaces. Source: catalog `open`; VS Code's preview editors
2. Open to the side to open the record beside the tab I am in, pinned, so later clicks leave it alone. Source: catalog `open`, placement
3. A file already open in a tab to be shown, not opened twice. Source: VS Code
4. Several records opened at once to open one grid: the first record's file, with the others as its columns. Source: catalog `open`; xEdit Compare Selected
5. The tab titled with the file's name, as any file is. The file is named by the record's EditorID, so the title carries it. Source: ADR-0001; plugin-source.md, The tree, story 1
6. Open from the palette, with no record given, to ask for one by EditorID, FormID or FormKey. Source: catalog `open`
7. A tab I leave and come back to to be as I left it: the rows I expanded, the columns I collapsed, the focused cell and the scroll. Source: VS Code keeps a tab's place
8. A record given without a plugin, from the palette, Referenced By or Go to record, to open the winning copy's file. Source: xEdit lands on the winning copy
9. An untracked plugin's copy, or the copy of a plugin whose plugin source is unreadable, to open as a document mEdit renders from the plugin, read-only. It is not a file, so the file features above do not reach it. Source: ADR-0007; ADR-0001
10. A child record, such as a placed reference, to open in a tab of its own, though it shares its cell's file. A change saved in either tab shows in both. Source: plugin-source.md, The tree, story 3

## The header

One line above the grid: the record type as xEdit names it, then `EditorID [FormKey]`, or the FormKey alone when there is no EditorID. It holds no controls.

## The record header

As a user, I want:

1. Record Header as the grid's first row, as in xEdit. Its rows are the header members Mutagen reads for the game, such as Record Flags, FormID and Form Version, in xEdit's order and under xEdit's labels. Each edits as any field does. Source: xEdit; ADR-0005; xedit.md, divergence 18
2. The FormID to show and take the FormKey. A plugin header's FormID is read-only, and an override's is refused, naming its master, where the record is native. Source: xedit.md, divergences 9 and 16

## Columns

As a user, I want:

1. One column for each active plugin that holds the record, in plugin order: the record's master on the left, the winning copy on the right. The file's column is marked as the one I edit. Source: xEdit; ADR-0012
2. A plugin that is not active not to be a column: an overridden plugin, a disabled plugin, or a plugin in a disabled mod. Source: ADR-0012
3. To collapse a column to a narrow strip from a control in its header, and to restore it the same way.
4. A cell in a column that cannot be edited, or that is not the file's, to open no editor, as in xEdit. Nothing marks its cells ahead of time. Its header says why, or opens its file. Source: xEdit; ADR-0018
5. Each column sized to fit, and its edge to drag to resize it.
6. The grid to scroll sideways from a scrollbar that stays at the bottom of the panel at every vertical position.
7. Opened on several records, one column for each, in the order I selected them, the first as the file. Their cells carry no conflict colour: the conflict model compares copies of one record. Source: xEdit Compare Selected; editor-conflicts.md
8. A click on a column's header to open that column's file, or its rendered document when the plugin is untracked or its plugin source is unreadable, in this tab, in place of the file I came from, with the same columns. Source: xEdit edits any column in one window; VS Code's Explorer opens a click in the preview tab

### A column's header

| Part | What it shows | Source |
|---|---|---|
| Label | `[XX] File name`: the plugin's load index, in hex, `[FE:XXX]` for a light plugin, and its file name. | xEdit |
| Status | the column's status, from the table below | ruling |
| Colour | the column's worst cell colour | [editor-conflicts.md](editor-conflicts.md) |
| Tooltip | the file name, the origin, and the status's reason in a sentence | ruling |

| Status | When | The tooltip says | Source |
|---|---|---|---|
| `(parse failure)` | mEdit could not read this copy of the record. The column shows what could be stored. | the diagnosis | Never silently wrong |
| `(read-only)` | the game folder provides the plugin | that the game's plugins are not edited | ruling |
| `(in Overwrite)` | the plugin is in Overwrite | that Overwrite is not a mod, and a plugin moved into a mod can be tracked | ruling |
| `(untracked)` | the plugin is not tracked | that Track, in this header's menu, makes it editable | ADR-0007 |
| `(Partial Form)` | this copy carries only its children, and the game ignores its own fields | that the game ignores this copy's own fields | xEdit; [editor-fields.md](editor-fields.md) |
| `(plugin source unreadable)` | the plugin is tracked, and its plugin source is missing or cannot be read | why, and that decompile, in this header's menu, makes it editable | Never silently wrong |
| `(tracked)` | the plugin is tracked | that an edit lands in the mod's working tree, for review in Source Control | ADR-0007 |

A column shows one status, the first in this table that applies. A Partial Form column is dimmed, header and cells alike, so it reads as outside the conflict after the header scrolls away.

## Rows

As a user, I want:

1. One row for each field that any column holds, in the order the record holds them in its file, as Mutagen groups them into fields. Source: xEdit; xedit.md, divergence 21
2. A field that holds other fields, a struct or an array, to expand into a row for each of them, indented one step for each level. Source: xEdit
3. Every row expanded when the record opens, as xEdit opens it. Source: xEdit
4. To expand and collapse a row from the arrow beside its label, by double clicking the label, or from the keys below. Source: VS Code's trees; xEdit

## The focused cell

The grid has one focused cell, and the keyboard acts on it. There is no selection of several cells and no text selection. Source: xEdit; ADR-0018

As a user, I want:

1. A click on a cell to focus it and do nothing else: its row highlights and the cell is outlined. Source: xEdit
2. A second click on the focused cell, F2, or a double click to open the cell's editor, in place. Each opens the same editor, at once. Source: xEdit; xedit.md, divergence 6
3. The editor to take the whole value, so typing or pasting replaces it. Enter, or moving the focus away, writes it and saves the file, so the tab never shows unsaved; Esc closes it and writes nothing. Source: VS Code's inline rename; commands.md, A gesture on an open document
4. The keys that move through a VS Code tree to move through the rows: Up, Down, Home, End, Page Up and Page Down. On the label column, Right expands a row or steps into it, and Left collapses it or steps out to its parent, as in a tree. On a value column, Left and Right move the focus a column, since a tree has no columns. Source: VS Code's trees; common, A view, story 5
5. Ctrl+C to copy the focused cell's value in any column; Ctrl+X to copy it and then delete it, as Delete does, and Ctrl+V to paste over it, in a column that can be edited. Source: xEdit; [editor-fields.md](editor-fields.md)
6. Delete to remove the focused element, and Alt+Up or Alt+Down to move it one step, as VS Code moves a line. Delete on a field that is not an element clears it, as xEdit's Clear does. Add has no key, since VS Code has none for it. Source: VS Code; catalog `remove element`, `move element`, `edit field`
7. The keys to act on the grid only while no editor is open. In an open editor they edit its text.
8. A right click to focus the cell and open its menu. Source: xEdit

## Drag and drop

As a user, I want:

1. To drag a cell onto a cell of the same field in another column, to copy its value there. The cell I drag from can be in any column; the one I drop on must be in a column that can be edited. Source: xEdit; catalog `edit field`, Options
2. A struct or array row to drag its whole value. Source: xEdit
3. An element dropped on an array's row to be added to that array. Source: xEdit
4. Nothing to advertise a drag: the pointer stays an arrow. Source: xEdit
5. A drop that cannot land, on a column that cannot be edited, on another field, or from outside the panel, to change nothing and say nothing. Source: Doing nothing is not an error

## States

As a user, I want:

1. Before the record's first read lands, an empty panel, so "not read yet" never reads as "no fields". Source: common, States, story 1
2. When the first read fails, in place of the grid, "Failed to load:" and the reason, and a line in the Output. No notification. The next good read replaces it. Source: common, States, story 2; ADR-0019
3. While mEdit is still indexing plugins, a message above the grid: "This record's comparison is not complete: the colours are not final." It goes by itself once they are, and the grid reads again. Source: Never silently wrong
4. When a record the tab showed is gone from every plugin, the panel to say the record is gone, naming it, in place of the grid.
5. The file's column to follow its document, and the other columns to read again when mEdit reports the record changed, from an edit of mine or from any other tool, and not before. The rows I expanded, the columns I collapsed, the focus and the scroll stay. Source: ADR-0015; ADR-0001
6. While mEdit cannot read a plugin the panel shows, the message above the grid saying "Showing the last good read:" and the reason. Source: common, States, story 6

## Menus and keys

The row menus follow VS Code's groups: open, change, source control, copy, then destroy. Only these items show; VS Code's own Cut, Copy and Paste items, which act on text on the screen, do not.

| Where | Items, in order |
|---|---|
| Cell | go to record (on a FormLink that resolves) · open field value (on a text field) · add (on an array, or an element of one) · remove (on an element) · move up · move down (on an element) · copy value |
| Column header | track (in a mod with no repository) · decompile (in a tracked mod) · compile (tracked) · copy… · delete (tracked) |
| Keys, on the focused cell | F2: edit. Ctrl+C: copy value. Ctrl+X: cut. Ctrl+V: paste. Delete: remove, or clear. Alt+Up, Alt+Down: move. |

As a user, I want:

1. Go to record to show the record the reference points to, in the panel's editor group, as VS Code's Go to Definition does. Source: xedit.md, divergence 8; catalog `open`; Stay in the panel
2. Open field value to open the field's text in a text editor tab beside the panel, titled `<field> [<file name>]`. Each save writes it; closing without saving writes nothing. Opened again, the same tab shows. In a column that cannot be edited, the tab is read-only, so a long value can still be read. Source: xedit.md, divergences 2 and 6; catalog `open field value`
3. Copy on a column to copy that plugin's copy of the record, asking for the mode and then the destination, as in Plugins. Source: catalog `copy`; xEdit's column header menu
4. Delete on a column to remove that plugin's copy of the record, after one confirmation naming it. Source: catalog `delete`; xEdit's column header menu
5. Compile and decompile on a column to act on that column's plugin, and track on its plugin's mod. Source: catalog `compile`, `decompile`, `track`

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refused edit to raise a notification that says why and names the field. The cell shows mEdit's value. Source: common, Reporting; A gesture that writes, story 2
2. A failed copy to the clipboard to say so. Source: ADR-0019

## Test seam

- The panel, given mEdit's answer for a record: the header, the columns, their statuses and order, the rows and their nesting, and the states, with no VS Code UI.
- A gesture's entry: given the focused cell and a click, key, drop or menu item, the command and Argument it fires, or nothing.
- The tab: its title, a file already open shown and not opened twice, a column's header opening its file in place, its place kept when hidden, and the read again on mEdit's report of a change.
- Menus and keys: the placement above, checked against the extension manifest.
