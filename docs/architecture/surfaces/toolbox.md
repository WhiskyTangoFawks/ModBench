# Toolbox

The Toolbox shows the instance itself: which game it is for and which profile is active, with the
gestures that act on the whole instance. Its template is MO2's top bar, run box and profile combo
([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs,
[mo2.md](../../out-of-scope/mo2.md) says why (divergence 1: VS Code has no container title bar, so
the Toolbox is a view of its own). Its gestures are in [commands.md](../commands.md) under Instance
and Profile; what each one writes is in its trace. What every view shares is in
[common.md](common.md).

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
| Game | the game the instance is for, as MO2's configuration names it | `$(game)` | the game folder | none |
| Profile | the active profile's name | `$(account)` | "Switch profile" | `switch` |

The Instance adapter reads which game the instance is for from the mod manager's configuration, and
where its folder is from the game folder setting, then the configuration's game path, then the Steam
install. The Instance loader carries both in the instance value. When either fails, the Toolbox
shows it as [common.md](common.md#states) says, stories 2, 4 and 5.

## States

The states every view shares are in [common.md](common.md#states). With no folder open, or a folder
that is not an instance, the Toolbox says so in place of its rows, as every view does, and its title
bar's gestures are absent. *common, States, story 4; No dead entries*

## Menus and keys

| Where | Items, in order |
|---|---|
| Title bar | 1: refresh. Overflow: open settings. |
| Profile menu | switch |
| Keys | Enter: the row's gesture, as a click does. |

As a user, I want:

1. Refresh to rebuild every read model from disk, the index included, as one gesture for all of
   Modbench. It is a safety net, never how a change normally arrives. *catalog `refresh`; ADR-0015*
2. Open settings to open VS Code's Settings on Modbench's own. *catalog `open settings`; mo2.md:
   VS Code provides the settings*

## Pickers, prompts and confirmations

### Switch profile

As a user, I want a pick of the instance's profiles, the active one marked. Choosing one switches to
it, and every view follows through the watch; Esc switches nothing. *catalog `switch`;
update-load-order-file, profile switch*

### Refresh

As a user, I want no confirmation, and the view's progress bar while it runs. *Confirm what destroys:
refresh destroys nothing on disk*

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refresh refused because another window holds the index to say "This instance's index is open
   in another Modbench window", and to name the instance. Modbench cannot name the other window.
   *catalog `refresh`; ADR-0009*
2. A failed refresh to stop there, re-reading nothing and sending nothing, and to say why.

## Deferred

| What | Waits on |
|---|---|
| `deploy / purge`, a toggle the Toolbox offers, with a Deployment row and the first-deploy consent | deployment after the alpha, #968; #971 removed today's |
| `select game` | a need for it |
| `run`, and `add`, `remove` and `edit executable` | #971 removed today's; their design |
| `log in`, `set up instance`, `track modlist`, `cancel` | their design |
| `create` a profile | its design |
| `validate` the instance | its design |

## Test seam

- **The view, given an instance value:** the rows and their parts, and the states, with no VS Code
  UI and no disk.
- **The pickers:** switch profile's items, the marked one, and what Esc yields.
- **Menus and keys:** the placement above, checked against the extension manifest.

