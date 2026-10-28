# Toolbox

The Toolbox shows the instance itself: which game it is for and which profile is active, with the gestures that act on the whole instance. Its template is MO2's top bar, run box and profile combo ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)); where it departs, [mo2.md](../out-of-scope/mo2.md) says why (divergence 1). Its gestures are in [commands.md](commands.md) under Instance, Profile and Modlist. What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The view

A native tree view, `modbench.toolbox`, first in the `modbench` container and open by default (commands.md, Where surfaces live). It is a readout, not a list: each row is one fact about the instance, and a row's click is that fact's gesture. So the list rules in common do not apply to it: it has no name filter, no sort direction, no Collapse All, and selecting several rows means nothing. A click never runs a gesture that writes with no prompt, so a stray click changes nothing.

As a user, I want every row to read the instance value and nothing else, so the Toolbox never disagrees with the views below it. Cites: ADR-0015

## Rows

| Row | Description | Icon | Tooltip | Click |
|---|---|---|---|---|
| Game | the game the instance is for, as the mod manager's configuration names it | `$(game)` | the game folder, the game's version, and the script extender's version, or that the game folder holds none, and how many links it holds, which Modbench ignores | none |
| Profile | the active profile's name | `$(account)` | "Switch profile" | `switch` |
| Modlist | "no repository", or "repository" ([modlist-repository.md](modlist-repository.md)) | `$(source-control)` | none | none |
| Deployment | the deployment folder's name, or "no deployment folder" ([deployment-hardlink.md](deployment-hardlink.md)) | `$(rocket)` | the deployment folder, and where deploy writes `plugins.txt` | `open settings`, at the deployment folder's setting |

As a user, I want the game folder to be the one my setting names, else the one the mod manager's configuration names, else the one Modbench finds on this machine.

## States

The states every view shares are in [common.md](common.md#states). As a user, I want:

1. With no game folder, the Game row to show `$(warning)` and "game folder not found", with a tooltip naming each place Modbench looked and the setting that fixes it.

## Menus and keys

| Where | Items, in order |
|---|---|
| Title bar | 1: refresh. Overflow: open settings · log in, or log out while logged in. |
| Profile menu | switch |
| Modlist menu | git init (no repository, or one git init has not set up) · update manifest · restore from manifest…, on every mod (a repository) |
| Deployment menu | inline: deploy. Menu: deploy · purge. |
| Keys | Enter: the row's gesture, as a click does. |

## Pickers, prompts and confirmations

### Switch profile

As a user, I want a pick of the instance's profiles, the active one marked. Choosing one switches to it; Esc switches nothing. Cites: catalog `switch`

### Refresh

As a user, I want no confirmation, and the view's progress bar while it runs. Cites: Confirm what destroys: refresh deletes only derived state, and rebuilds it

### Log in

As a user, I want:

1. A password prompt for my Nexus API key. Esc keeps nothing. Cites: MO2's Enter API Key Manually
2. A key Nexus refuses to be refused in the prompt, so a key I keep is one that works. Cites: Refuse, do not repair
3. The key kept in VS Code's secret storage, for every instance, and never in a setting or the instance, so no commit holds it. Cites: Existing tools
4. Log out to forget the key with no confirmation. Nexus keeps the key, and I paste it again. This is an exception to Confirm what destroys.

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refresh refused because another window holds the record index to say "This instance is open in another Modbench window. Close it, then refresh.", and to name the instance. Modbench cannot name the other window. Cites: catalog `refresh`; Never silently wrong; ADR-0003
2. A failed refresh to say why.

## Test seam

- The view, given an instance value: the rows and their parts, and the states, with no VS Code UI and no disk.
- The pickers: switch profile's items, the marked one, and what Esc yields.
- Menus and keys: the placement above, checked against the extension manifest.

