# xEdit UX Audit — the right-pane compare grid

An audit of how xEdit's **View** pane actually behaves, read from source, to serve as the reference
model for mEdit's record editor. mEdit's goal is to port xEdit's interaction model into VS Code as
closely as the platform allows, so this document is the thing mEdit is measured *against* — it
describes xEdit, not mEdit, and takes no position on what mEdit should do.

Exists because specifying from memory of xEdit once produced **single-click-to-edit** — which xEdit
does not do — and that one wrong assumption cascaded into gesture conflicts. Audit first; it is
cheaper.

## Sources

All paths relative to `references/TES5Edit/` (grep-only clone; never modified).

| What | Where |
| --- | --- |
| Tree configuration | `xEdit/xeMainForm.dfm:105-160` (`vstView`, on tab "View") |
| Single click | `xEdit/xeMainForm.pas:18387` `vstViewClick` |
| Double click | `xEdit/xeMainForm.pas:18619` `vstViewDblClick` |
| Inline editor creation | `xEdit/xeMainForm.pas:18472` `vstViewCreateEditor` → `18507` `vstCreateEditor` |
| Is editing allowed | `xEdit/xeMainForm.pas:18792` `vstViewEditing` |
| Drag permission | `xEdit/xeMainForm.pas:18689` `vstViewDragAllowed`; drop at `18706` `vstViewDragDrop` |
| Keyboard | `xEdit/xeMainForm.pas:19264` `vstViewKeyDown` |
| Ctrl-hover link affordance | `xEdit/xeMainForm.pas:551` decl, `5166` wiring, body `vstViewCheckHotTrack` |
| User-facing tips | `xEdit/EditTips.txt` — xEdit's own UX documentation, 60+ lines |

**Verification status.** Everything below is read from xEdit's own source except where marked
*framework* — those are behaviours of the VirtualTreeView control that xEdit configures but does not
implement. `External/VirtualTrees/` is an uncloned submodule in this checkout, so framework
behaviour is inferred from the option names plus observed behaviour, and is flagged as such rather
than asserted.

## The mental model

The View pane is a **grid**, not a document: column 0 is the field-name/label column (fixed, 250px),
and each subsequent column is one record being compared. Two pieces of state, and the distinction
matters:

- **Selection** — `toFullRowSelect`: the whole *row* highlights.
- **Focus** — `toExtendedFocus`: focus lands on a *single cell* (`FocusedNode` + `FocusedColumn`),
  and it is the focused cell that every keyboard action operates on.

The View pane is **single-select** — `SelectionOptions = [toExtendedFocus, toFullRowSelect,
toRightClickSelect, toSimpleDrawSelection]`, with no `toMultiSelect`. (The Weapon/Armor/Ammo
spreadsheet tabs *do* add `toMultiSelect`; the left-hand records tree adds it too, which is what
`EditTips` means by "Hold Ctrl or Shift while clicking in the left pane to select several records".)

`toGridExtensions` is set, which is what makes arrow keys traverse cells horizontally as well as
vertically rather than moving only between rows.

## Mouse

| Gesture | Behaviour |
| --- | --- |
| **Single click**, value column | Sets row selection and cell focus. Nothing else. |
| **Single click**, already-focused cell | Begins inline editing (*framework* — `toEditOnClick`). This is the Explorer "slow double-click to rename" pattern: first click focuses, a later click on the focused cell edits. |
| **Ctrl+click**, value column | Follows the reference to its record (`vstViewClick`). |
| **Click and hold, drag** | Drags the cell's value (`toFullRowDrag` — the drag can begin anywhere in the row). |
| **Double click**, column 0 | Expand/collapse the node. When comparing siblings, sorts instead. |
| **Double click**, value column | Two outcomes — see below. |
| **Right click** | Selects the row (`toRightClickSelect`) and opens `pmuView`. |
| **Ctrl+hover** | Underlines the value as a followable link, *only* when it resolves. |

`vstViewClick` is worth stating explicitly because it is the whole reason xEdit has no gesture
conflict: **it exits immediately unless Ctrl is held.**

```pascal
if vstView.HotColumn < 1 then Exit;
if GetKeyState(VK_CONTROL) >= 0 then Exit;   // not Ctrl -> do nothing
if not vstView.HotTrack then Exit;
```

Plain single click is left entirely to the tree's own focus machinery. xEdit adds *no* behaviour to
it. Selection is therefore free to be what a single click means, and editing has to be reached some
other way.

`vstViewCheckHotTrack` gates the link affordance on the same two conditions as the click that
follows it — Ctrl held, and `LinksTo` assigned and not the record already being viewed:

```pascal
Allow := Assigned(lLinksTo) and not lLinksTo.Equals(ActiveRecord);
```

A link you cannot follow never looks like one.

### Double click on a value cell

`vstViewDblClick` branches on the field's type:

- **`dtInteger`, `dtFlag`, `dtFloat`** and the element is editable → `vstView.EditNode(...)`, the
  **inline** editor.
- **Everything else** (strings, FormIDs, structures…) → opens `TfrmViewElements`, a **separate
  editor window** showing that element across all compared records. Modeless (`Show`) normally;
  modal when `wbIKnowWhatImDoing` is set or **Shift** is held.

`EditTips` states the user-visible half of this: *"Double click on text fields in the right pane to
open multiline editor."* So double click does not mean "edit inline" — it means "open the richest
editor this type has", which for three numeric-ish types happens to be the inline one.

## Keyboard

All operate on the **focused cell** (`vstViewKeyDown`), and all editing paths additionally require
`wbEditAllowed` and `Element.IsEditable`.

| Key | Behaviour |
| --- | --- |
| **F2** | Activate the inline editor (*framework*; `EditTips`: "Pressing F2 in the right pane activates inplace editor"). |
| **Ctrl+C** | `Clipboard.AsText := Element.EditValue`, falling back to `Element.Summary` when `EditValue` is empty. |
| **Ctrl+X** | Copies `EditValue`, then sets it to `''`. Only when `EditValue` is non-empty. |
| **Ctrl+V** | `Element.EditValue := Clipboard.AsText`. Only when the clipboard is non-empty. |
| **Insert** / **Ctrl+Insert** | Add a list entry (routes through the context menu's `Add`). |
| **Delete** | Remove the entry, or Clear the value if Remove isn't applicable. |
| **Ctrl+Up** / **Ctrl+Down** | `Element.MoveUp` / `MoveDown` — reorder within an unsorted list. |
| **Ctrl+M** | Create ModGroup. |
| **?** | Jump focus to the filter box (`vstViewKeyPress`). |

**Copy is a clipboard operation on the focused cell's model value, not a text selection.** There is
no text selection in the grid at all. `Element.EditValue` is the same string the inline editor would
have shown, which is what makes copy and paste symmetric — `EditTips` calls this out: *"Press Ctrl+C
to copy to clipboard the text of the selected data node in the right or left pane, handy for copying
and editing FormIDs."*

## Editors by type

`vstCreateEditor` maps the element's `EditType` onto a control:

| `EditType` | Control |
| --- | --- |
| `etDefault` | Text edit |
| `etComboBox` | Combo box, sorted, 16 drop-down rows, populated from `Element.EditInfo` |
| `etCheckComboBox` | Check-combo — multi-select checklist, i.e. a bitmask/flags editor |

`vstViewCreateEditor` **exits when Shift is held**, suppressing the inline editor so the
Shift+double-click modal path can take over.

Note the editor kinds are chosen by the *element's* declared edit type, not by a UI-side type switch.

## Drag and drop

- **Allowed when**: `wbEditAllowed`, the column is a value column, and the cell has an element
  (`vstViewDragAllowed`). Source mutability is not checked — only the drop target's.
- **`toFullRowDrag`** — the drag may begin anywhere in the row, not from a handle.
- **`toAcceptOLEDrop`** — the tree accepts OLE drops, so values can come from outside.
- Dragging a **header/structure row** copies the whole structure or list: *"you can copy even whole
  structures and lists if you drag by the header."*
- Dropping an entry **onto a list's header** duplicates it into that list.

## Right-click menu (`pmuView`)

Named, discrete actions live here — `Add`, `Remove`, `Clear`, `Move Up`/`Move Down`, `Compare
selected`, `Copy to selected`, `Stick to`, ModGroup creation. Several keyboard shortcuts above are
implemented by *invoking these menu items*, so the menu is the canonical definition of each action
and the keys are accelerators onto it.

## What xEdit deliberately does not do

- **No single-click activation of anything.** Click selects; that is all it does.
- **No text selection inside the grid.** Copy is a clipboard command on the focused cell.
- **No drag handle.** The whole row is the drag source, and the cursor never advertises it.
- **No per-cell affordance for editability.** A read-only element simply refuses to edit
  (`vstViewEditing` sets `Allowed := False`); nothing is greyed or hidden ahead of time.
- **No modal confirmation on edit** beyond the one-time `EditWarn`.

## The one-line summary

> Click focuses a cell. The focused cell is what the keyboard acts on — `Ctrl+C`/`Ctrl+X`/`Ctrl+V`
> move its value, `F2` or a second click edits it in place, `Delete`/`Insert`/`Ctrl+Arrow` restructure
> its list. Double click opens the fullest editor the type has. Ctrl turns references into links.
> Drag copies values between columns. Nothing is activated by a single click.
