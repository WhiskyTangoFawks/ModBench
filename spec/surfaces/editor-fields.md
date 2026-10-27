# Editor: how each field reads and edits

A cell in the record panel is one plugin's value for one field. This file says what a cell reads, what its editor is, and what copy, cut and paste do, type by type. How a cell is focused, opened and dragged is in [editor.md](editor.md); its colours are in [editor-conflicts.md](editor-conflicts.md). The field's type, its default and what it may hold come from the record type's schema, and the panel adds no rule of its own ([ADR-0005](../adr/0005-the-document-is-the-record-model.md)). What a value reads as is xEdit's answer, and reading changes neither the value an edit writes nor the value copy takes (ADR-0018).

Each story cites what decides it. A story that cites nothing is owned here.

## Every field

As a user, I want:

1. A value to read as what it means, never as it is stored: an enum or a flag by its name, a reference by its record, never "null" or "undefined". Never a raw integer, except an enum value the enum does not name (By type). Cites: ADR-0018
2. A value the record holds, but its document leaves out because it equals its default, to read as the default its schema declares. A field the record does not hold at all to read as nothing, as xEdit shows a subrecord a plugin lacks. Cites: ADR-0005; xEdit
3. A value too wide for its column cut with an ellipsis, and copied whole.
4. Ctrl+C to copy the value as its editor shows it, so Ctrl+V takes it back unchanged. Cites: xEdit's EditValue
5. Ctrl+V to take the text on the clipboard as if I had typed it. Text the field cannot hold is refused, naming the field, and nothing changes. Cites: xEdit; Refuse, do not repair
6. A cleared value to read as story 2 says. Clearing a value already cleared changes nothing. Cites: xEdit's Clear; Doing nothing is not an error
7. A field the schema marks read-only to open no editor, as a column that cannot be edited does, with the reason in its tooltip. Cites: ADR-0005

## By type

| Type | The cell reads | The editor | Ctrl+C copies |
|---|---|---|---|
| Text, and translated text | the text; a translated text whose strings file is missing reads `<Error: No strings file>`, with the file it looked for in its tooltip | a text box in place; open field value for a long text | the text |
| Integer | the number | a number box | the number |
| Float | the number | a number box | the full number |
| True or false | `True` or `False` | a check box, which writes as it is clicked | `True` or `False` |
| Enum | the member's name; a value the enum does not name reads `<Unknown: 5>` | VS Code's quick pick of the names, opened on the current one | the name |
| Flags | collapsed, the names of the flags set, joined by `, `; expanded, a check box for each flag | the check boxes, each of which writes as it is clicked | the names, joined by `, ` |
| Reference | the EditorID, or the FormKey when it resolves to no record of an active plugin, or to one with no EditorID; `—` for no reference; `EditorID [FormKey]` in its tooltip | the record picker, below | `EditorID [FormKey]` |
| Bytes | `0x` and the bytes in uppercase hex | a text box; a different length is refused | the text |
| Colour | `#AARRGGBB`, or `#RRGGBB` for a colour that holds no alpha, as mEdit gives it; a swatch of the colour beside it | a text box | the text |
| Vector | `x, y, z`, as mEdit gives it; a placed reference's rotation, which mEdit's schema marks, also in degrees beside it | a text box | `x, y, z` |
| Struct | collapsed, `{…}` or its reading, below; expanded, its members | none: its members edit | the whole value, as JSON |
| Array | collapsed, its reading, below; expanded, its elements | none: its elements edit | the whole value, as JSON |

Cites: xEdit's editors by type; xedit.md, divergences 1, 5, 10, 11, 12, 38 and 39; mEdit's answer; Never silently wrong

A struct or array row pastes, and takes a drop, of a whole value copied from the same field. Cites: xEdit

The strings language setting chooses the language a translated text shows in, English by default. The source keeps every language the plugin's strings hold. Cites: xEdit, Localization > Language; commands.md, VS Code provides it

## Placeholders

A placeholder says a struct or array is there and collapsed, so it is drawn for each column. As a user, I want:

1. A column whose plugin has nothing there, such as an array slot past its own length, an optional struct that is unset, or a member its kind does not have, to show an empty cell.
2. A struct that cannot be unset to keep its placeholder, with each member at its default. Cites: ADR-0005
3. A row no column has a value for, which holds only its children, to keep its placeholder in every column.

## References

As a user, I want:

1. The record picker to be VS Code's quick pick, opened on the current reference, with that record selected. Cites: xedit.md, divergence 1
2. Typing to search by EditorID, FormID or FormKey, among the record types the field allows. Cites: xEdit; ADR-0005
3. A pasted `EditorID [FormKey]` to search by the FormKey in its brackets, so a label that has gone stale still finds the right record.
4. Enter to write the record I chose, and Esc to change nothing. Cites: Esc changes nothing
5. A dangling or type-mismatched FormLink to carry a warning in its cell, with the reason in its tooltip. Each cell carries its own. Cites: GLOSSARY.md, FormLink
6. A reference to a record the engine defines, such as the player, to resolve with no warning, though no plugin holds it. Cites: xEdit
7. Go to record on a reference that resolves, and on one of the wrong type, as xEdit follows both. Cites: xEdit; [editor.md](editor.md)

## Arrays

Every array takes add and remove, and an array without a key takes move. Some arrays' elements have a key, which is the element's identity (ADR-0018). Cites: catalog `add element`, `remove element`, `move element`

As a user, I want:

1. Every array written back in the order I leave it: nothing re-sorts one. Cites: xedit.md, divergence 14
2. An array whose elements have a key to align across the columns by that key. Any other array to align by its values in sequence, as a diff does. A plugin with fewer elements than its master then reads as an absence where they are missing. Two elements that share a key, as another tool can write them, each on a row of their own. Cites: xEdit; ADR-0018; xedit.md, divergence 14
3. Add on an array's row, whether it is collapsed or expanded, to append a new element as xEdit adds one: the first kind the field lists, with the members a plugin needs to keep the element, at their defaults. Cites: xEdit; ADR-0005
4. A key another element holds to be accepted, on add and on edit: the game uses a repeated key, as a leveled list weights an entry by repeating it. Story 2 shows each on a row of its own. Cites: xEdit
5. Move up absent on the first element, and move down on the last. Cites: No dead entries

## A field of several kinds

Some fields hold one of several kinds of value, such as an alias that is a reference, a location or a collection. As a user, I want:

1. A Kind row that chooses between them from VS Code's quick pick of the kinds, named as the schema names them, never a class name. Cites: xedit.md, Choose the next or previous member of a union
2. Switching the kind to keep the members both kinds have, to drop the rest, and to fill the members a plugin needs to keep the new kind, at their defaults, as add does. Cites: Arrays, story 3

## Collapsed readings

A collapsed element reads by the first row that applies; otherwise it reads `{…}`. Cites: xEdit; xedit.md, divergence 17

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

1. A reading to go one level deep: a property whose value is a list or a struct reads by its name and kind. Cites: xEdit
2. An element with no reading, inside one that has, to read `{…}`, so the count stays true.
3. The elements joined by `, `, with no length limit: the cell cuts what does not fit.

## Conditions

A condition list is an array like any other. As a user, I want:

1. A parameter the condition's function does not use to have no row, unless a column uses it, so an overridden record's data is never hidden. Cites: xedit.md, divergence 13
2. A change of function, or of Run On, to empty the parameters it leaves unused, so a stale value never reaches the plugin.
3. The function chosen from VS Code's quick pick, in a row named Function, also where the schema holds one kind per function. Cites: xEdit; an exception to § A field of several kinds, story 1

## Scripts

A record's script data (its VMAD) is a struct like any other, and its scripts, properties and values edit as the fields above. Editing Papyrus source is not the record panel's.

## Record flags

Record Flags offers the flags the game gives every record and the flags the record's type adds. Three flags change more than their bit, as in xEdit. Cites: xEdit; ADR-0005

As a user, I want:

1. Setting Partial Form to empty the copy's own fields, all but its EditorID. Cites: xEdit
2. Setting Deleted to empty the copy's fields. Cites: xEdit
3. Clearing Partial Form or Deleted to make the copy match the nearest copy to its left that is neither: its own fields, its EditorID, its Record Flags and its Form Version. A change to Persistent then moves it, as story 4 says. With no such copy, its own fields and EditorID stay empty. Cites: xEdit; ADR-0008
4. Setting Persistent on a placed record to move it into its cell's persistent group, and clearing it to move it into the temporary group. In an exterior worldspace, setting it moves the record into the worldspace's persistent cell, and clearing it moves the record into the cell at its position. A cell the plugin lacks is copied in as an override, or created. Cites: xEdit
5. Setting or clearing Persistent on a deleted record refused, naming the reason. Cites: xedit.md, divergence 24

## Partial Form

A Partial Form copy's own fields are read-only, and show empty: the game ignores them. Its EditorID and its Record Header rows edit, and its children edit as any record's. Cites: xEdit

## A plugin's header

A plugin's header is a record, and reads and edits as one. Its masters are the masters the working tree's content requires, and are never edited. Cites: ADR-0008; catalog `edit field`

## Test seam

- A cell, given a field's schema and a column's value: what it reads, its editor, what Ctrl+C copies, and what a pasted text writes, or the refusal.
- An array: given the focused row, which of add, remove, move up and move down are offered.
- A collapsed element: given its value, what it reads.
- The record picker: its items, what it opens on, what a pasted label searches, and what Esc yields.
- The enum pick: its items (the names sorted, `<Unknown: n>` included when the value is unnamed), what it opens on (the current value), and what Esc yields (nothing).
