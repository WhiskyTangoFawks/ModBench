# Editor: conflict colours

The record panel colours each row and each cell by the record order conflict it shows, so a
conflict reads at a glance instead of by diffing each value. The classification is xEdit's two-axis
model ([ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md), invariant 3;
[the conflict-model notes](../../research/xedit-conflict-model.md)). mEdit classifies; the panel
only draws what it is given ([ADR-0005](../../adr/0005-the-document-is-the-record-model.md),
invariant 6). Where the panel departs from xEdit, [xedit.md](../../out-of-scope/xedit.md) says why.
The rows, columns and cells are [editor.md](editor.md)'s.

Each story cites its source. A story with no source is owned here.

## The two axes

- **ConflictAll**, one for each row: the state of that field across every copy.
- **ConflictThis**, one for each cell: this plugin's copy of the field against the others.

A row can be in conflict while its master's cell is only the master and the winner's cell wins.
xEdit's benign and ignored states come from its priority table, which Modbench does not have
(xedit.md, divergence 9).

## Rows

| ConflictAll | Row background | Means |
|---|---|---|
| OnlyOne, NoConflict | none | one copy has the field, or every copy agrees |
| Override | green | copies change the field, and none disagrees with another |
| Conflict | orange | copies disagree on the field |

*ADR-0018, invariant 3; xedit.md, divergence 6; old spec*

As a user, I want:

1. Each row painted from its own field, so one changed field tints its own row and no other. *old
   spec*
2. A collapsed struct or array row to show the worst state beneath it, so collapsing hides nothing,
   and an expanded one to show no background, since its rows show their own. *xedit.md, divergence
   6*
3. A background to mean that something here needs a look: a field every copy agrees on has none.
   *xedit.md, divergence 6*

## Cells

| ConflictThis | Cell background | Text | Means |
|---|---|---|---|
| Master, OnlyOne | none | default | the record's master, or the only copy |
| IdenticalToMaster | grey | default | the copy has the field, unchanged from the master |
| Override | green | default | changed from the master, and no other copy disagrees |
| ConflictWins | orange | default | disagrees with another copy, and wins |
| ConflictLoses | red | red | disagrees with another copy, and loses |

*ADR-0018, invariant 3; old spec*

As a user, I want:

1. A cell whose plugin has nothing there to have no colour. *old spec*
2. Each column's header painted with the worst state among its cells, as a summary; the cells are
   what count. *old spec*

## What takes part

As a user, I want:

1. Only the copies the game loads compared, which are the only columns. *ADR-0013, invariant 3;
   [editor.md](editor.md)*
2. A Partial Form copy's own fields left out of the comparison, as if it did not have them, even
   where they differ: the game ignores them. Its children compare as any record does. *xEdit*
3. A field's winner to be the last copy that has a value for it, so a Partial Form copy that leaves
   a field out never wins it. *xEdit*
4. A sorted array compared element by element by its key or its value, and an unsorted one by
   position. *xEdit; [editor-fields.md](editor-fields.md)*

## The colours

As a user, I want:

1. Each colour to be a theme colour Modbench contributes, with its own defaults for dark, light and
   high contrast themes, so a theme or my settings can change it, as xEdit's options change its
   colours. *xedit.md: VS Code provides options*
2. A cell's tooltip to name its state, in xEdit's words, so the colour is never the only way to
   tell.
3. Until mEdit has computed the conflicts for every plugin, the colours to be marked as not final.
   *[editor.md](editor.md), States, story 3; ADR-0019, invariant 1*

## Deferred

| What | Waits on |
|---|---|
| A record's own conflict state, ConflictCritical included, on its row in Plugins, as xEdit's navigator shows it | its design |
| `hide no-conflict rows` | #250 |

## Test seam

- **The panel, given mEdit's classification:** each row's background, collapsed and expanded, each
  cell's background and text, each header's colour, and each cell's tooltip.
- **Theme colours:** each colour the panel paints with is contributed in the extension manifest,
  with a default for each kind of theme.
