# Toolbox

The Toolbox shows the instance itself: which game it is for and which profile is active, with the
gestures that act on the whole instance. Its template is MO2's top bar, run box and profile combo
([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs,
[mo2.md](../../out-of-scope/mo2.md) says why (divergence 1). Its gestures are in
[commands.md](../commands.md) under Instance and Profile; what each one writes is in its trace. What
every view shares is in [common.md](common.md).

Each story cites its source. A story with no source is owned here.

## The view

A native tree view, `modbench.toolbox`, first in the `modbench` container and open by default
(commands.md, Where surfaces live). It is a readout, not a list: each row is one fact about the
instance, and a row's click is that fact's gesture. So the list rules in common do not apply to it:
it has no name filter, no sort direction, no Collapse All, and selecting several rows means
nothing.

As a user, I want every row to read the instance value and nothing else, so the Toolbox never
disagrees with the views below it. *ADR-0015*

## Rows

| Row | Description | Icon | Tooltip | Click |
|---|---|---|---|---|
| Game | the game the instance is for, as the mod manager's configuration names it | `$(game)` | the game folder | none |

The game folder is the one my setting names, else the one the mod manager's configuration names,
else the game's install, found as Steam or Wine installs it.
| Profile | the active profile's name | `$(account)` | "Switch profile" | `switch` |

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no game folder, the Game row to show `$(warning)` and "game folder not found", with a
   tooltip naming each place Modbench looked and the setting that fixes it.

## Menus and keys

| Where | Items, in order |
|---|---|
| Title bar | 1: refresh. Overflow: open settings. |
| Profile menu | switch |
| Keys | Enter: the row's gesture, as a click does. |

## Pickers, prompts and confirmations

### Switch profile

As a user, I want a pick of the instance's profiles, the active one marked. Choosing one switches to
it; Esc switches nothing. *catalog `switch`*

### Refresh

As a user, I want no confirmation, and the view's progress bar while it runs. *Confirm what destroys:
refresh deletes only derived state, and rebuilds it*

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refresh refused because another window holds the index to say "This instance's index is open
   in another Modbench window", and to name the instance. Modbench cannot name the other window.
   *catalog `refresh`; ADR-0009*
2. A failed refresh to say why.

## Test seam

- **The view, given an instance value:** the rows and their parts, and the states, with no VS Code
  UI and no disk.
- **The pickers:** switch profile's items, the marked one, and what Esc yields.
- **Menus and keys:** the placement above, checked against the extension manifest.

