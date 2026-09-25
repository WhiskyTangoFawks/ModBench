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
   reference by its record, never a raw integer, never "null" or "undefined". *ADR-0005, invariant 3;
   ruling*
2. A value the plugin leaves out to read as the field's default, and its editor to open on it. A
   plugin leaves out a value equal to its default, so a blank would say something untrue. *ADR-0005,
   invariant 1; ruling*
3. A value too wide for its column cut with an ellipsis, and copied whole. *ruling*
4. Ctrl+C to copy the value as the cell reads it. *xEdit*
5. Ctrl+V to take the text on the clipboard as if I had typed it. Text the field cannot hold is
   refused, naming the field, and nothing changes. *xEdit; Refuse, do not repair*
6. Ctrl+X, and Delete on a field that is not an element, to clear the value: it reads as the field's
   default afterwards. A value already at its default changes nothing. *xEdit's Clear; Doing nothing
   is not an error*
7. A field the schema marks read-only to open no editor, as a column that cannot be edited does,
   with the reason in its tooltip. *ADR-0005, invariant 6*

## By type

| Type | The cell reads | The editor | Ctrl+C copies | The default reads |
|---|---|---|---|---|
| Text, and translated text | the text | a text box in place; open field value for a long text | the text | nothing |
| Integer | the number | a number box | the number | `0` |
| Float | the number | a number box | the number as it reads | `0` |
| True or false | `True` or `False` | a check box, which writes as it is clicked | `True` or `False` | `False` |
| Enum | the member's name; a value the enum does not name reads `<Unknown: 5>` | a dropdown of the names | the name | the default the schema names |
| Flags | collapsed, the names of the flags set, joined by `, `; expanded, a check box for each flag | the check boxes, each of which writes as it is clicked | the names, joined by `, ` | nothing |
| Reference | `EditorID [FormKey]`, or the FormKey alone when it resolves to no record | the record picker, below | `EditorID [FormKey]` | `—` |
| Bytes | `0x` and the bytes in uppercase hex | a text box; a different length is refused | the text | `—` |
| Colour | `#AARRGGBB`, as mEdit gives it | a text box | the text | `—` |
| Vector | `x, y, z`, as mEdit gives it | a text box | the text | `—` |
| Struct | collapsed, `{…}` or its reading, below; expanded, its members | none: its members edit | the whole value, as JSON | `{…}` |
| Array | collapsed, `[n]` or its elements' readings; expanded, its elements | none: its elements edit | the whole value, as JSON | `[0]` |

*xEdit's editors by type; xedit.md, divergences 1 and 7; ruling; mEdit's answer*

A struct or array row pastes, and takes a drop, of a whole value copied from the same field.
*xEdit*

## Placeholders

A placeholder says a struct or array is there and collapsed, so it is drawn for each column. As a
user, I want:

1. A column whose plugin has nothing there, such as an array slot past its own length, an unset
   struct that may be unset, or a member its kind does not have, to show an empty cell. *ruling*
2. A struct that cannot be unset to keep its placeholder, with each member at its default. *ruling;
   ADR-0005, invariant 1*
3. A row no column has a value for, which holds only its children, to keep its placeholder in every
   column. *ruling*

## References

As a user, I want:

1. The record picker to be VS Code's quick pick, opened on the current reference, with that record
   selected. *xedit.md, divergence 1*
2. Typing to search by EditorID, or by FormKey. When the field allows one record type, the search
   is among that type only. *xEdit; ruling; mEdit's answer*
3. A pasted `EditorID [FormKey]` to search by the FormKey in its brackets, so a label that has gone
   stale still finds the right record. *ruling*
4. Enter to write the record I chose, and Esc to change nothing. *Esc changes nothing*
5. A reference that resolves to no record, or to a type the field does not allow, to carry a warning
   in its cell, with the reason in its tooltip. Each cell carries its own. *CONTEXT.md, FormLink;
   ruling*
6. A reference to a record the engine defines, such as the player, to resolve with no warning,
   though no plugin holds it. *xEdit*
7. Go to record on a reference that resolves, and on one of the wrong type, as xEdit follows both.
   *xEdit; [editor.md](editor.md)*

## Arrays

xEdit sorts some arrays and not others, and the kind decides what I can do to an element
(ADR-0018, invariant 3).

| Kind | Example | Add | Remove | Move up, move down |
|---|---|---|---|---|
| Unsorted | a quest's script fragments, a package's procedure tree | yes | yes | yes |
| Sorted by a key | scripts by name, a script's properties by name | yes | yes | no |
| Sorted by value | a list of keywords | yes | yes | no |

*xEdit; catalog `add element`, `remove element`, `move element`*

As a user, I want:

1. A sorted array written back in its order whatever I do, so no move could change it. *xEdit*
2. A sorted array aligned across the columns by its key, or by its value, so a plugin with fewer
   elements than its master reads as an absence where they are missing, not as every row after them
   shifting. An unsorted array stays aligned by position. *xEdit; ADR-0018, invariant 3*
3. The keys xEdit sorts by: scripts and alias scripts by script name, properties and struct members
   by property name, a perk's fragments by index, a quest's fragments by stage and index, a scene's
   phase fragments by index and flags, a quest's alias bindings by alias number. *xEdit*
4. Add on an array's row, whether it is collapsed or expanded, to append a new element, empty but
   for its kind, which is the first the field lists. *xEdit; ruling*
5. Two elements with the same key refused, naming the key: the key is the element's identity. A
   second new element in a keyed array meets this until I name the first. *xEdit; ruling*
6. Move up absent on the first element, and move down on the last. *No dead entries*

## A field of several kinds

Some fields hold one of several kinds of value, such as an alias that is a reference, a location or
a collection. As a user, I want:

1. A Kind row that chooses between them, a dropdown of the kinds named as the schema names them,
   never a class name. *ruling; xedit.md: the Kind dropdown chooses the member*
2. Switching the kind to keep the members both kinds have, and to drop the rest. *ruling*
3. A member the column's kind does not have to show an empty cell. *ruling*

## Collapsed readings

A collapsed element reads as xEdit summarises it, where xEdit has a summary for it; otherwise it
reads `{…}`. *xEdit; ruling*

| Element | Reads |
|---|---|
| A script | `ScriptName(<each property>)` |
| A script property | `Name: Kind = value`, where Kind is the property's kind as the schema names it |
| An object binding | `Object, Alias[n]`: `None` for -1, `Player` for -2, otherwise the number |
| A condition | the Run On subject, then the function and the parameters it uses, then the operator, the value, and `AND` or `OR` joining it to the next; the last condition has none |

As a user, I want:

1. A reading to go one level deep: a property whose value is a list or a struct reads by its name
   and kind. *xEdit*
2. An element with no reading, inside one that has, to read `{…}`, so the count stays true. *ruling*
3. The elements joined by `, `, with no length limit: the cell cuts what does not fit. *ruling*

## Conditions

A condition list is an array like any other. As a user, I want:

1. A parameter the condition's function does not use to have no row, unless a column uses it, so an
   overridden record's data is never hidden. *ruling; xedit.md, divergence 15; ADR-0005, invariant 7*
2. A change of function, or of Run On, to empty the parameters it leaves unused, so a stale value
   never reaches the plugin. *ADR-0005, invariant 7*
3. The function chosen from the ordinary enum dropdown. *ruling*

## Scripts

A record's script data (its VMAD) is a struct like any other, and its scripts, properties and values
edit as the fields above. Editing Papyrus source is not the record panel's. *ruling*

## Partial Form

A Partial Form copy's own fields are read-only, and show empty: the game ignores them. Its children
edit as any record's. *xEdit; mEdit's answer*

## A plugin's header

A plugin's header is a record, and reads and edits as one. Its masters are the Effective masters,
and are never edited. *ADR-0008, invariant 2; catalog `edit field`*

## Deferred

| What | Waits on |
|---|---|
| More collapsed readings | #435 |
| Setting the Partial Form flag | its design |
| A Partial Form copy's EditorID and record flags editable, and its own values shown | mEdit's answer |
| Colour and vector as structs of their parts, as xEdit shows them, with Alpha on the four colours xEdit gives one | mEdit's answer |
| The picker's search limited to a field's record types when it allows several | mEdit's answer |
| An alias number read as the alias's name | its design |

## Test seam

- **A cell, given a field's schema and a column's value:** what it reads, its editor, what Ctrl+C
  copies, and what a pasted text writes, or the refusal.
- **An array:** given its kind and the focused row, which of add, remove, move up and move down are
  offered.
- **A collapsed element:** given its value, what it reads.
- **The record picker:** its items, what it opens on, what a pasted label searches, and what Esc
  yields.
