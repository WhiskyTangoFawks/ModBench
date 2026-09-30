# Editor: how each field reads and edits

A cell in the record panel is one plugin's value for one field. This file says what a cell reads,
what its editor is, and what copy, cut and paste do, type by type. How a cell is focused, opened and
dragged is in [editor.md](editor.md); its colours are in
[editor-conflicts.md](editor-conflicts.md). The field's type, its default and what it may
hold come from the record type's schema, and the panel adds no rule of its own
([ADR-0005](../../adr/0005-the-document-is-the-record-model.md), invariants 2 and 6). What a value
reads as is xEdit's answer, and reading changes neither the value an edit writes nor the value copy
takes (ADR-0005, invariant 3).

Each story cites its source. A story with no source is owned here.

## Every field

As a user, I want:

1. A value to read as what it means, never as it is stored: an enum or a flag by its name, a
   reference by its record, never "null" or "undefined". Never a raw integer, except an enum value
   the enum does not name (By type). *ADR-0005, invariant 3*
2. A value the record holds, but its document leaves out because it equals its default, to read as
   the default its schema declares. A field the record does not hold at all to read as nothing, as
   xEdit shows a subrecord a plugin lacks. *ADR-0005, invariants 1, 2 and 7; xEdit*
3. A value too wide for its column cut with an ellipsis, and copied whole.
4. Ctrl+C to copy the value as its editor shows it, so Ctrl+V takes it back unchanged. *xEdit's
   EditValue*
5. Ctrl+V to take the text on the clipboard as if I had typed it. Text the field cannot hold is
   refused, naming the field, and nothing changes. *xEdit; Refuse, do not repair*
6. A cleared value to read as story 2 says. Clearing a value already cleared changes nothing.
   *xEdit's Clear; Doing nothing is not an error*
7. A field the schema marks read-only to open no editor, as a column that cannot be edited does,
   with the reason in its tooltip. *ADR-0005, invariant 6*

## By type

| Type | The cell reads | The editor | Ctrl+C copies |
|---|---|---|---|
| Text, and translated text | the text | a text box in place; open field value for a long text | the text |
| Integer | the number | a number box | the number |
| Float | the number | a number box | the full number |
| True or false | `True` or `False` | a check box, which writes as it is clicked | `True` or `False` |
| Enum | the member's name; a value the enum does not name reads `<Unknown: 5>` | a dropdown of the names | the name |
| Flags | collapsed, the names of the flags set, joined by `, `; expanded, a check box for each flag | the check boxes, each of which writes as it is clicked | the names, joined by `, ` |
| Reference | `EditorID [FormKey]`, or the FormKey alone when it resolves to no record of an active plugin; `—` for no reference | the record picker, below | `EditorID [FormKey]` |
| Bytes | `0x` and the bytes in uppercase hex | a text box; a different length is refused | the text |
| Colour | `#AARRGGBB`, as mEdit gives it | a text box | the text |
| Vector | `x, y, z`, as mEdit gives it | a text box | the text |
| Struct | collapsed, `{…}` or its reading, below; expanded, its members | none: its members edit | the whole value, as JSON |
| Array | collapsed, its reading, below; expanded, its elements | none: its elements edit | the whole value, as JSON |

*xEdit's editors by type; xedit.md, divergences 1, 5, 10, 11 and 12; mEdit's answer*

A struct or array row pastes, and takes a drop, of a whole value copied from the same field.
*xEdit*

## Placeholders

A placeholder says a struct or array is there and collapsed, so it is drawn for each column. As a
user, I want:

1. A column whose plugin has nothing there, such as an array slot past its own length, an optional
   struct that is unset, or a member its kind does not have, to show an empty cell.
2. A struct that cannot be unset to keep its placeholder, with each member at its default.
   *ADR-0005, invariant 1*
3. A row no column has a value for, which holds only its children, to keep its placeholder in every
   column.

## References

As a user, I want:

1. The record picker to be VS Code's quick pick, opened on the current reference, with that record
   selected. *xedit.md, divergence 1*
2. Typing to search by EditorID, FormID or FormKey. When the field allows one record type, the search
   is among that type only. *xEdit; mEdit's answer*
3. A pasted `EditorID [FormKey]` to search by the FormKey in its brackets, so a label that has gone
   stale still finds the right record.
4. Enter to write the record I chose, and Esc to change nothing. *Esc changes nothing*
5. A dangling or type-mismatched FormLink to carry a warning in its cell, with the reason in its
   tooltip. Each cell carries its own. *CONTEXT.md, FormLink*
6. A reference to a record the engine defines, such as the player, to resolve with no warning,
   though no plugin holds it. *xEdit*
7. Go to record on a reference that resolves, and on one of the wrong type, as xEdit follows both.
   *xEdit; [editor.md](editor.md)*

## Arrays

Every array takes the same gestures. Some arrays' elements have a key, which is the element's
identity (ADR-0018, invariant 3). *catalog `add element`, `remove element`, `move element`*

As a user, I want:

1. Every array written back in the order I leave it: nothing re-sorts one. *xedit.md, divergence 14*
2. An array whose elements have a key to align across the columns by that key. Any other array to
   align by its values in sequence, as a diff does. A plugin with fewer elements than its master
   then reads as an absence where they are missing. *xEdit; ADR-0018, invariant 3; xedit.md,
   divergence 14*
3. Add on an array's row, whether it is collapsed or expanded, to append a new element, empty but
   for its kind, which is the first the field lists. *xEdit*
4. Two elements with the same key refused, naming the key: the key is the element's identity. A
   second new element in a keyed array meets this until I set the first one's key. *xEdit*
5. Move up absent on the first element, and move down on the last. *No dead entries*

## A field of several kinds

Some fields hold one of several kinds of value, such as an alias that is a reference, a location or
a collection. As a user, I want:

1. A Kind row that chooses between them, a dropdown of the kinds named as the schema names them,
   never a class name. *xedit.md, Choose the next or previous member of a union*
2. Switching the kind to keep the members both kinds have, and to drop the rest.

## Collapsed readings

A collapsed element reads by the first row that applies; otherwise it reads `{…}`. *xEdit; xedit.md,
divergence 17*

| Element | Reads |
|---|---|
| A script | `ScriptName(<each property>)` |
| A script property | `Name: Kind = value`, where Kind is the property's kind as the schema names it |
| An object binding | `Object, Alias[n]`: `None` for -1, `Player` for -2, otherwise the number |
| A condition | the Run On subject, then the function and the parameters it uses, then the operator, the value, and `AND` or `OR` joining it to the next; the last condition has none |
| An array element with a key | its key's reading |
| An array with one element | that element's reading |
| Any other array | `[n]` |

As a user, I want:

1. A reading to go one level deep: a property whose value is a list or a struct reads by its name
   and kind. *xEdit*
2. An element with no reading, inside one that has, to read `{…}`, so the count stays true.
3. The elements joined by `, `, with no length limit: the cell cuts what does not fit.

## Conditions

A condition list is an array like any other. As a user, I want:

1. A parameter the condition's function does not use to have no row, unless a column uses it, so an
   overridden record's data is never hidden. *xedit.md, divergence 13; ADR-0005, invariant 7*
2. A change of function, or of Run On, to empty the parameters it leaves unused, so a stale value
   never reaches the plugin. *ADR-0005, invariant 7*
3. The function chosen from the ordinary enum dropdown.

## Scripts

A record's script data (its VMAD) is a struct like any other, and its scripts, properties and values
edit as the fields above. Editing Papyrus source is not the record panel's.

## Partial Form

A Partial Form copy's own fields are read-only, and show empty: the game ignores them. Its children
edit as any record's. *xEdit; mEdit's answer*

## A plugin's header

A plugin's header is a record, and reads and edits as one. Its masters are the masters the working
tree's content requires, and are never edited. *ADR-0008, invariant 2; catalog `edit field`*

## Test seam

- **A cell, given a field's schema and a column's value:** what it reads, its editor, what Ctrl+C
  copies, and what a pasted text writes, or the refusal.
- **An array:** given the focused row, which of add, remove, move up and move down are
  offered.
- **A collapsed element:** given its value, what it reads.
- **The record picker:** its items, what it opens on, what a pasted label searches, and what Esc
  yields.
