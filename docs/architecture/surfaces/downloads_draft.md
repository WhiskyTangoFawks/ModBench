# Downloads

The Downloads surface lists the downloaded files in the instance's `downloads/` folder. Its gestures
are in [commands.md](../commands.md), under Downloaded file. This file says what the user sees:
the rows, their states, the order, the empty and error cases, and the pickers.

It follows MO2's Downloads tab ([ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md)).
Where it differs, [mo2.md](../../out-of-scope/mo2.md) says why.

## Where it lives

The fourth view in the Activity Bar container, collapsed by default (see "Where surfaces live" in
commands.md). VS Code's own "Focus on Downloads View" opens it. There is no command of its own to
open it. It is always present. With nothing to show it renders its empty state, and it never hides
itself.

The folder is the MO2 instance's shared `downloads/`, never a Modbench-private one, so MO2 and
Modbench can alternate on one instance without diverging
([ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)).

## Rows

One row per downloaded file. The `.meta` sidecar is never a row of its own.

| Part | What it shows |
|---|---|
| Identity | the raw file name. The selection follows it, so editing the name later does not drop the selection. |
| Label | the `.meta` `name`, otherwise the raw file name. Never blank. |
| Description | the version, then a status word. The status word is left out for Downloaded, the default. |
| Icon | always carries the status. Downloaded: a green archive. Installed: a check, no colour. Uninstalled: a yellow circle with a slash. There is no file-type icon, because it would never vary. |
| Tooltip | file name, mod name, version, Nexus ID, size, file time, game and author. Each appears only if the sidecar records it. Size and file time live here because a tree has no columns. A row with no sidecar still gets the minimal tooltip. |

Excluded rows, when shown, appear beside the visible rows, dimmed. MO2 draws no dim.

## What a row's state means

The status comes from the `.meta`:

| `.meta` says | Status |
|---|---|
| `installed=true` | Installed |
| `uninstalled=true` | Uninstalled |
| neither | Downloaded |

- A file with no sidecar is a valid row, Downloaded. The gestures that need a sidecar are absent for
  it: `view on Nexus`, `open` with the `.meta` as its target, and `query info`.
- A successful install writes `installed=true` back, so the row flips to Installed.
- Excluding a file writes `removed=true`. Including it clears the flag.
- The Nexus mod and file IDs are absent when they are missing or `0`.
- The surface trusts the sidecar. It does not check the installed mods against it.
- A hand-edited sidecar with spaces around `=` must read back correctly, although MO2 never writes
  them.

## Order, filter and view state

- **Sort.** By name, status, size or file time, in either direction. The default is file time,
  newest first. The sort is stable in both directions, because status has three values and ties are
  common.
- **Show excluded** decides which rows exist. The name filter then narrows the rest. The filter
  changes only what is drawn.
- **Transient state.** The sort choice and show excluded reset each time the extension activates and
  are never saved. The filter follows the shared rule: it stays until cleared.

## Selection rules

- `install`, `view on Nexus` and `open` act on the clicked row only. A selection of
  several would open several tabs, and MO2 does not batch installs either.
- `delete`, `exclude` and `include` act on the whole selection.
- A selection that mixes excluded and included rows applies the clicked row's direction to every
  row, because a menu condition cannot see the mix.

## States

| Case | What the user sees |
|---|---|
| No files | a "no downloads yet" message |
| The first read fails | one error node carrying the reason, reported once. The next good read replaces it with rows. |
| A row with no sidecar | the minimal row and tooltip. Nothing warns, because it is already a valid row. |

## Pickers and confirmations

**Delete.** One confirmation for the whole selection. A single row uses the single-file wording. The
file and its sidecar go to the system trash, the sidecar first, so a failure never leaves a sidecar
without its file. Deleting never uninstalls the mod.

**Install from a downloaded file.** The download supplies its path, so there is no file picker. The
install specification is still open. This is what exists today for an upgrade.

- The candidates are the installed mods that share the download's Nexus mod ID.
- Each candidate shows the mod name and version.
- A candidate whose recorded installed files include the file's ID shows "File ID match". Otherwise
  the candidate whose recorded installation file is this download shows it. That candidate is named
  first and highlighted by default.
- A last row reads "Install as a new mod...".
- With no mod ID, or no shared mod, the pick is skipped.
- Esc installs nothing. The file name is never consulted.
- Choosing a new mod goes on to the name prompt. Choosing an upgrade skips it.

## Not here

Drag to install is not planned. MO2's "info incomplete" icon and a density option are not built. A
status-bar count of downloads in progress, and a progress bar, wait for the Nexus download work.

## Collected, not yet placed

Found in the CLAUDE.md review, stated nowhere else. To be placed when this spec is written.

- A failure to write the download's `.meta` after an install must not read as "install failed".
  The install landed, and a user told it failed retries it.
