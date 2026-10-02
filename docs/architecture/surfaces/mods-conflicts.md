# Mods: the conflict table

The conflict table shows one mod's file order conflicts: a row for each file it shares with another enabled mod, and a column for each enabled mod that has a copy. Its template is the Conflicts tab of MO2's Information dialog ([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../../out-of-scope/mo2.md) says why. Its colours are the record panel's ([editor-conflicts.md](editor-conflicts.md)), so one conflict reads the same for a record and for a file. Its gestures are in [commands.md](../commands.md) under Mod.

The table is a grid, not a list, so the list rules in [common.md](common.md) do not apply to it. Its States and Reporting do.

Each story cites its source. A story with no source is owned here.

## Opening

As a user, I want:

1. Open conflicts, on a mod row that has a file order conflict, to open the mod's table as a preview editor, which my next open replaces. *catalog `open conflicts`; VS Code's preview editors*
2. The tab titled `Conflicts: <mod name>`. *MO2*
3. A mod whose table is open in a tab of its own to be shown, not opened twice. *VS Code*

## Columns

As a user, I want:

1. One column for each enabled mod that has a copy of a row's file, in mod order: losing on the left, winning on the right. *MO2; the record panel's columns*
2. The opened mod's column outlined, so I find it among the others.
3. Each column's header to show the mod's name, coloured with the column's worst cell colour. *[editor-conflicts.md](editor-conflicts.md), Cells, story 2*

## Rows

As a user, I want:

1. One row for each file the mod has that another enabled mod also has, as a folder tree: folders first, then files, each by name. *MO2's Conflicts tab*
2. An excluded file to take no part, in the mod that excluded it. *MO2*
3. Every folder expanded when the table opens, and to collapse and expand a folder by a click on it. *xEdit opens every row*
4. A click on a file's name to open the opened mod's copy as a preview editor. *VS Code*
5. The keys that move through a VS Code tree to move through the rows: Up, Down, Home, End, Page Up and Page Down, and Right and Left to expand and collapse a folder. *VS Code's trees*

## Cells

A cell is one mod's copy of one file. Its state and its colour are the record panel's ([editor-conflicts.md](editor-conflicts.md)), read for a file: the master is the losing-most copy, and two copies are the same when their bytes are the same. A copy is lost when it differs from both the master and the winning copy.

| Row | For a file |
|---|---|
| NoConflict | every copy is the same |
| Override | a copy differs from the master, and no copy is lost |
| Conflict | a copy is lost |

| Cell | For a file |
|---|---|
| none | the mod has no copy |
| Master | the losing-most copy |
| ConflictWins | the winning copy, in a Conflict row |
| ConflictLoses | a lost copy |
| IdenticalToMaster | the same as the master |
| Override | the same as the winning copy |

A cell takes the first state in this table that applies.

As a user, I want:

1. Each cell and each row coloured as [editor-conflicts.md](editor-conflicts.md) colours a field, from the states above. A collapsed folder shows the worst state beneath it, and an expanded one shows none. *editor-conflicts, Rows, story 2*
2. Each cell to show one value of its copy. A setting chooses the value: the size, which is the default; the date modified; or a letter for its contents, A for the master's, so two cells with the same letter hold the same file.
3. A cell's tooltip to name the mod, the state in xEdit's words, the size and the date modified, so the colour is never the only way to tell. *editor-conflicts, The colours, story 2*

## States

As a user, I want:

1. Before the first read lands, an empty table, so "not read yet" never reads as "no conflicts". *common, States, story 1*
2. A mod with no file order conflict to show "No file order conflicts." in place of the table.
3. A mod that is disabled to show "Disabled: its files take no part in mod order." in place of the table. *ADR-0013, invariant 2*
4. A mod that is gone from the mod list to show that it is gone, naming it, in place of the table.
5. The table to follow the disk: a change to any copy, or to mod order, shows with no action of mine. The folders I collapsed and the scroll stay. *common, A view, story 2; ADR-0015*

## Menus and keys

| Where | Items, in order |
|---|---|
| Cell | compare file (a copy that is not the winning copy) |
| Column header | open conflicts |
| Keys | the tree keys of Rows, story 5 |

As a user, I want:

1. Compare file to open VS Code's diff editor, the cell's copy on the left and the winning copy on the right, titled with the file and both mods. *catalog `compare file`*
2. Open conflicts on a column header to open that mod's table. *catalog `open conflicts`*

## Test seam

- **The table, given the instance value and the copies' contents:** the columns and their order, the rows and their nesting, each cell's state and value, each row's state, each folder's worst state, and the states.
- **A gesture's entry:** given a cell or a column header and a menu item, the command and Argument it fires, or nothing.
- **Menus:** the placement above, checked against the extension manifest.
