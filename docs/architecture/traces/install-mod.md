# install-mod: contract

Diagram: [install-mod.d2](install-mod.d2). Catalog row: `install` under Mod in
[commands.md](../commands.md). What the user picks and types is in
[mods.md](../surfaces/mods.md), Create empty mod and install, and
[downloads.md](../surfaces/downloads.md), The install target. Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

`install` puts a source, an archive, a folder or a downloaded file, into `mods/`: as a new mod, or
over an installed mod, which is an upgrade. The caller states the target: a new mod and its name,
or an installed mod the user confirmed. Install never infers the target from disk.

## The flow

1. Downloads or Mods sends `install` to the install box: the source, the target, and, for a
   downloaded file, what its `.meta` knows: the Nexus mod ID, the file ID and the version.
2. The install box refuses a new mod whose folder exists, and an upgrade whose folder has gone. It
   checks here whatever the prompt checked, because the disk can change in between.
3. Through the Instance adapter, it stages the source in a folder inside the instance root, on the
   same volume as `mods/`: it extracts an archive, or copies a folder.
4. It finds the mod's root: a `Data/` folder, or the level that holds the plugins and asset
   folders, below any single wrapper folder. A FOMOD installer is found and flagged. Its steps do
   not run, and its files stay as they are.
5. It writes `meta.ini` through the codec: the game, the Nexus mod ID, the version, the installation
   file and the installed files. On an upgrade, a key the source does not know keeps its old value,
   so an unknown version never blanks a known one. Every key install does not own survives.
6. The mod lands:
   - **A new mod.** `meta.ini` is written in the staged tree first. Then one rename moves the tree
     into `mods/<name>`, so the folder is never seen half built.
   - **An upgrade.** The folder's contents are replaced in place, except `.git`. The folder is never
     renamed, so its identity, its repository and its watchers survive (ADR-0007).
7. For a downloaded file, it marks the file installed in its `.meta`, for MO2's Downloads tab
   (ADR-0017, invariant 1).
8. The install box removes the staging folder, then answers: applied, and whether the source was a
   FOMOD, or the refusal. It keeps no copy.

## Hand-off

This flow waits for no hand-off. Install writes no `modlist.txt` line.

- The Instance loader's watch sees the folder. `mod sync` adds its line at the winning end,
  disabled, and `plugin sync` adds its plugins' lines
  ([update-load-order-file](update-load-order-file.md)).
- For a tracked mod, the Mod watcher sees the new bytes and the moved `meta.ini` version.
  [decompile-plugin](decompile-plugin.md)'s trigger asks, with the new baseline as the default.
  That question is the user's notice that tracked files changed.

## Refusals

The install box refuses before it writes to `mods/`, and names the cause.

| Refusal | Where | Why |
|---|---|---|
| A new mod whose folder exists, naming it and pointing at an upgrade | a new mod | A folder is never merged into or replaced by surprise. |
| An upgrade whose folder has gone, naming it | an upgrade | A gone object is refused. |
| `mods/` is on another volume than the instance root | a new mod | One rename cannot move the mod in, and a mod folder is never copied in pieces. |
| The archive cannot be extracted, with the reason, or no 7-Zip is found, naming what to install | an archive | |

## Failure

- **A new mod.** A failure before the rename leaves `mods/` as it was.
- **The `.meta` mark.** A failed mark is a line in the Output, and the install stands
  ([downloads.md](../surfaces/downloads.md), Reporting).

Exceptions to the principles:

- **A failed gesture writes nothing.** An upgrade that fails after the old files are removed is not
  rolled back. It says so, naming the folder and what failed. Installing the download again is the
  recovery, and a tracked mod's source stays in git.

## Test seam

- **The install box:** given a source, a target and the files on disk, the folder, `meta.ini` and
  `.meta` written, or the refusal and `mods/` untouched.
