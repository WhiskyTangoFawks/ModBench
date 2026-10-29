# Editor: conflict colours

The record panel colours each row and each cell by the record order conflict it shows, so a conflict reads at a glance instead of by diffing each value. The classification is xEdit's two-axis model ([ADR-0018](../adr/0018-xedit-is-the-reference-for-record-editing.md); [the conflict-model notes](../../docs/research/xedit-conflict-model.md)). mEdit classifies; the panel only draws what it is given. Where the panel departs from xEdit, [xedit.md](../out-of-scope/xedit.md) says why. The rows, columns and cells are [editor.md](editor.md)'s.

Each story cites what decides it. A story that cites nothing is owned here.

## The two axes

- ConflictAll, one for each row: the state of that field across every copy.
- ConflictThis, one for each cell: this plugin's copy of the field against the others.

The axes are independent. A Conflict row can hold a Master cell and a ConflictWins cell. xEdit's benign and ignored states come from its priority table, which Modbench does not have, but for the version stamps (xedit.md, divergence 7). A compare of several records caps each row at ConflictBenign, as xEdit does (What takes part, story 6).

## Rows

| ConflictAll | Row background | Means |
|---|---|---|
| OnlyOne, NoConflict | none | the record has one copy, or every copy agrees |
| Override | green | copies change the field, and none disagrees with another |
| Conflict | orange | copies disagree on the field |
| ConflictBenign | orange | opened on several records, they disagree on the field |

Cites: ADR-0018; xedit.md, divergence 4

As a user, I want:

1. Each row painted from its own field, so one changed field tints its own row and no other.
2. A collapsed struct or array row to show the worst state beneath it, so collapsing hides nothing, and an expanded one to show no background, since its rows show their own. Cites: xedit.md, divergence 4
3. Version Control Info 1, Form Version and Version Control Info 2 to show no conflict colour: the game ignores them. Cites: xEdit; xedit.md, divergence 7

## Cells

| ConflictThis | Cell background | Text | Means |
|---|---|---|---|
| Master, OnlyOne | none | default | the record's master, or the only copy |
| IdenticalToMaster | grey | default | the copy has the field as the master has it, or neither has it |
| Override | green | default | changed from the master, and no other copy disagrees |
| ConflictWins | orange | default | disagrees with another copy, and wins |
| ConflictLoses | red | red | disagrees with another copy, and loses |

Cites: ADR-0018

As a user, I want:

1. A copy that does not have a field the master has to read as a change to it, as xEdit reads it. A field no copy has shows no colour. Cites: xEdit; Never silently wrong
2. Each column's header painted with the worst state among its cells, as a summary; the cells are what count.
3. A collapsed column's cells to keep their colour without their text. The strip then shows where the copy differs, as VS Code's overview ruler shows where a file changes. Cites: VS Code's interaction

## What takes part

As a user, I want:

1. Only the active plugins' copies compared. An overridden plugin's column, shown when I open its file, is left out of the comparison: the game never loads it. Cites: ADR-0012; [editor.md](editor.md)
2. A Partial Form copy's own fields left out of the comparison, even where they differ: the game ignores them. Its children compare as any record does. Cites: xEdit
3. A field's winner to be the last copy that takes part in it, whether or not that copy has the field: the game loads that copy whole. A Partial Form copy takes no part in its own fields (story 2), so the last copy before it wins them. A templated field is an exception (story 7). Cites: xEdit
4. Arrays compared as they align ([editor-fields.md](editor-fields.md), Arrays). Cites: xEdit
5. A container's conflict to be its own fields'. Its child records compare as records of their own, never as a list in the container: the game loads every plugin's children, not the winner's list. Cites: ruling; xEdit
6. A panel opened on several records to compare the records with each other. A row is NoConflict where they agree on the field, and ConflictBenign where they do not. A cell is compared with its row's cell in the focused column: it is Master in the focused column, Override where it is the same, and ConflictLoses where it differs. This is an exception to The two axes: a cell compares with the focused column, not with the other copies. Cites: xEdit Compare Selected
7. A templated field ([editor-fields.md](editor-fields.md), Templated fields) left out of the comparison, with no conflict colour. The rows that hold the template flags and name the templates show the conflict over it. Where the last copy's field is templated, no copy wins it: the row shows no conflict colour, and every cell in it dims. Cites: Never silently wrong; xedit.md, divergence 40

## The colours

As a user, I want:

1. Each colour to be a theme colour Modbench contributes, with its own defaults for dark, light and high contrast themes, so a theme or my settings can change it, as xEdit's options change its colours. Cites: xedit.md, VS Code provides it
2. A cell's tooltip to name its state, in xEdit's words, so the colour is never the only way to tell.

## Test seam

- The panel, given mEdit's classification: each row's background, collapsed and expanded, each cell's background and text, in an open and a collapsed column, each header's colour, and each cell's tooltip.
- Theme colours: each conflict colour the panel paints with is contributed in the extension manifest, with a default for each kind of theme.
