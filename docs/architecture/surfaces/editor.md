# Editor: the record panel

The record panel shows one record as every active plugin has it: a row for each field, a column for each plugin. Its template is xEdit's View grid ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md)); where it departs, [xedit.md](../../out-of-scope/xedit.md) says why. Its gestures are in [commands.md](../commands.md) under Record, Plugin, Mod (`track`) and Every view.

The Editor surface has three more files:

- [editor-fields.md](editor-fields.md): how each field reads and edits, type by type.
- [editor-conflicts.md](editor-conflicts.md): the colours of a record order conflict.
- [editor-referenced-by.md](editor-referenced-by.md): the Referenced By view.

The panel is a grid, not a list, so the list rules in [common.md](common.md) do not apply to it. Its States, Unconfirmed writes and Reporting do.

Each story cites its source. A story with no source is owned here.

## Opening

The record tab is a VS Code editor, and each record has its own address. Preview, pinning, Go Back and Go Forward, the recent editors, reopening a closed tab, and restoring the tabs after a reload behave as they do for any file. *VS Code; ADR-0018, invariant 1*

As a user, I want:

1. A click on a record in Plugins or Referenced By to open it as a preview editor, which my next click replaces. *catalog `open`; VS Code's preview editors*
2. Open to the side to open the record beside the tab I am in, pinned, so later clicks leave it alone. *catalog `open`, placement*
3. A record already open in a tab of its own to be shown, not opened twice. *VS Code*
4. Several records opened at once each to open in a tab of its own. *catalog `open`*
5. The tab titled with the EditorID, or the FormKey when there is none. A plugin header's tab is titled with the plugin's file name. *catalog `open`: a plugin header is a record*
6. Open from the palette, with no record given, to ask for one by EditorID, FormID or FormKey. *catalog `open`*
7. A tab I leave and come back to to be as I left it: the rows I expanded, the columns I collapsed, the focused cell and the scroll. *VS Code keeps a tab's place*

## The header

One line above the grid: the record type as xEdit names it, then `EditorID [FormKey]`, or the FormKey alone when there is no EditorID. It holds no controls.

## The FormID

As a user, I want the record's FormKey as the first row of the grid, under Record Header, with xEdit's label FormID. It edits as any field does. A plugin header's FormID is read-only, and an override's is refused, naming its master, where the record is native. *xedit.md, divergences 9 and 16*

## Columns

As a user, I want:

1. One column for each active plugin that holds the record, in plugin order: the record's master on the left, the winning copy on the right. *xEdit; ADR-0012*
2. A plugin that is not active not to be a column: an overridden plugin, a disabled plugin, or a plugin in a disabled mod. *ADR-0012, invariant 5*
3. To collapse a column to a narrow strip by clicking its header, and to restore it the same way.
4. A cell in a column that cannot be edited to open no editor, as in xEdit. Nothing marks its cells ahead of time. Its header says why. *xEdit; ADR-0018*
5. Each column sized to fit, and its edge to drag to resize it.
6. The grid to scroll sideways from a scrollbar that stays at the bottom of the panel at every vertical position.

### A column's header

| Part | What it shows | Source |
|---|---|---|
| Label | `[XX] File name`: the plugin's load index, in hex, `[FE:XXX]` for a light plugin, and its file name. | xEdit; ADR-0012, invariant 3 |
| Status | the column's status, from the table below | ruling |
| Colour | the column's worst cell colour | [editor-conflicts.md](editor-conflicts.md) |
| Tooltip | the file name, the origin, and the status's reason in a sentence | ADR-0012, invariant 3 |

| Status | When | The tooltip says | Source |
|---|---|---|---|
| `(parse failure)` | mEdit could not read this copy of the record. The column shows what could be stored. | the diagnosis | ADR-0005, invariant 5 |
| `(read-only)` | the plugin is the game's own, a DLC's or a Creation Club plugin | that the game's plugins are not edited | ruling |
| `(in Overwrite)` | the plugin is in Overwrite | that Overwrite is not a mod, and a plugin moved into a mod can be tracked | ruling |
| `(untracked)` | the plugin is not tracked | that Track, or decompile in a tracked mod, in this header's menu, makes it editable | ADR-0007, invariant 1 |
| `(Partial Form)` | this copy carries only its children, and the game ignores its own fields | that the game ignores this copy's own fields | xEdit; [editor-fields.md](editor-fields.md) |
| `(tracked)` | the plugin is tracked | that an edit lands in the mod's working tree, for review in Source Control | ADR-0007, invariants 4 and 5 |

A column shows one status, the first in this table that applies. A Partial Form column is dimmed, header and cells alike, so it reads as outside the conflict after the header scrolls away.

## Rows

As a user, I want:

1. One row for each field that any column holds, in the order mEdit gives them. *mEdit's answer*
2. A field that holds other fields, a struct or an array, to expand into a row for each of them, indented one step for each level. *xEdit*
3. Every row expanded when the record opens, as xEdit opens it. *xEdit*
4. To expand and collapse a row from the arrow beside its label, by double clicking the label, or from the keys below. *VS Code's trees; xEdit*

## The focused cell

The grid has one focused cell, and the keyboard acts on it. There is no selection of several cells and no text selection. *xEdit; ADR-0018, invariant 3*

As a user, I want:

1. A click on a cell to focus it and do nothing else: its row highlights and the cell is outlined. *xEdit*
2. A second click on the focused cell, F2, or a double click to open the cell's editor, in place. Each opens the same editor, at once. *xEdit; xedit.md, divergence 6*
3. The editor to take the whole value, so typing or pasting replaces it. Enter, or moving the focus away, writes it; Esc closes it and writes nothing. *VS Code's inline rename*
4. The keys that move through a VS Code tree to move through the rows: Up, Down, Home, End, Page Up and Page Down. On the label column, Right expands a row or steps into it, and Left collapses it or steps out to its parent, as in a tree. On a value column, Left and Right move the focus a column, since a tree has no columns. *VS Code's trees; common, A view, story 5*
5. Ctrl+C to copy the focused cell's value in any column; Ctrl+X to copy it and then clear it, and Ctrl+V to paste over it, in a column that can be edited. *xEdit; [editor-fields.md](editor-fields.md)*
6. Delete to remove the focused element, and Alt+Up or Alt+Down to move it one step, as VS Code moves a line. Delete on a field that is not an element clears it, as xEdit's Clear does. Add has no key, since VS Code has none for it. *VS Code; catalog `remove element`, `move element`, `edit field`*
7. The keys to act on the grid only while no editor is open. In an open editor they edit its text.
8. A right click to focus the cell and open its menu. *xEdit*

## Drag and drop

As a user, I want:

1. To drag a cell onto a cell of the same field in another column, to copy its value there. The cell I drag from can be in any column; the one I drop on must be in a column that can be edited. *xEdit; catalog `edit field`, Options*
2. A struct or array row to drag its whole value. *xEdit*
3. An element dropped on an array's row to be added to that array. *xEdit*
4. Nothing to advertise a drag: the pointer stays an arrow. *xEdit*
5. A drop that cannot land, on a column that cannot be edited, on another field, or from outside the panel, to change nothing and say nothing. *Doing nothing is not an error*

## States

As a user, I want:

1. Before the record's first read lands, an empty panel, so "not read yet" never reads as "no fields". *common, States, story 1*
2. When the first read fails, in place of the grid, "Failed to load:" and the reason, and a line in the Output. No notification. The next good read replaces it. *common, States, story 2; ADR-0019, invariant 2*
3. While mEdit is still indexing plugins, a message above the grid: "This record's comparison is not complete: the colours are not final." It goes by itself once they are, and the grid reads again. *ADR-0019, invariant 1*
4. When a record the tab showed is gone from every plugin, the panel to say the record is gone, naming it, in place of the grid.
5. The panel to read the record again when mEdit reports it changed, from an edit of mine or from any other tool, and not before. The rows I expanded, the columns I collapsed, the focus and the scroll stay. *ADR-0015, invariant 3*
6. While mEdit cannot read a plugin the panel shows, the message above the grid saying "Showing the last good read:" and the reason. *common, States, story 6*

## Menus and keys

The row menus follow VS Code's groups: open, change, source control, copy, then destroy. Only these items show; VS Code's own Cut, Copy and Paste items, which act on text on the screen, do not.

| Where | Items, in order |
|---|---|
| Cell | go to record (on a FormLink that resolves) · open field value (on a text field) · add (on an array, or an element of one) · remove (on an element) · move up · move down (on an element) · copy value |
| Column header | track (in a mod with no repository) · decompile (in a tracked mod) · compile (tracked) · copy… · delete (tracked) |
| Keys, on the focused cell | F2: edit. Ctrl+C: copy value. Ctrl+X: cut. Ctrl+V: paste. Delete: remove, or clear. Alt+Up, Alt+Down: move. |

As a user, I want:

1. Go to record to show the record the reference points to, in the same tab. *xedit.md, divergence 8; catalog `open`; Stay in the panel*
2. Open field value to open the field's text in a text editor tab beside the panel, titled `<field> [<file name>]`. Each save writes it; closing without saving writes nothing. Opened again, the same tab shows. In a column that cannot be edited, the tab is read-only, so a long value can still be read. *xedit.md, divergences 2 and 6; catalog `open field value`*
3. Copy on a column to copy that plugin's copy of the record, asking for the mode and then the destination, as in Plugins. *catalog `copy`; xEdit's column header menu*
4. Delete on a column to remove that plugin's copy of the record, after one confirmation naming it. *catalog `delete`; xEdit's column header menu*
5. Compile and decompile on a column to act on that column's plugin, and track on its plugin's mod. *catalog `compile`, `decompile`, `track`*

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refused edit to raise a notification that says why and names the field. The cell shows mEdit's value again. *common, Unconfirmed writes, story 6*
2. A failed copy to the clipboard to say so. *ADR-0019, invariant 2*

## Test seam

- **The panel, given mEdit's answer for a record:** the header, the columns, their statuses and order, the rows and their nesting, and the states, with no VS Code UI.
- **A gesture's entry:** given the focused cell and a click, key, drop or menu item, the command and Argument it fires, or nothing.
- **The tab:** its title, a record already open shown and not opened twice, its place kept when hidden, and the read again on mEdit's report of a change.
- **Menus and keys:** the placement above, checked against the extension manifest.
