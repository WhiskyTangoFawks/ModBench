# install-mod: contract (draft)

Diagram: [install-mod.d2](install-mod.d2). It draws both targets, because an upgrade is `install`
with an installed mod as the target, through the same boxes. Catalog row: `install` under Mod in [commands.md](../commands.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md) and
[ADR-0017](../../adr/0017-mo2-is-the-reference-for-mod-management.md).

Each story cites its source. **Install is under a specification workup**, so this file holds only what
the catalog, the diagrams and the principles settle. The rest is in the Open Questions.

The `modlist.txt` line is not written here. The folder appears, and `import plugin` and `import mod`
pick it up. Their stories are in
[update-load-order-file_draft.md](update-load-order-file_draft.md).

## Shared

As a user, I want:

1. To install from an archive, a folder or a downloaded file. *catalog Argument*
2. A downloaded file to supply its own source, and the Mods menu to ask me for one. *catalog Meaning;
   The surface supplies the Argument*
3. Esc on any prompt or pick to install nothing. *Esc changes nothing*
4. A failure to leave `mods/` as it was, and to tell me why. *A failed gesture writes nothing;
   ADR-0019*
5. The new or changed folder to reach every view through the watch. *A write is forgotten; ADR-0015,
   invariant 2*
6. The download's `.meta` to record that it is installed, so its row shows Installed. *the Downloads
   surface, [downloads.md](../surfaces/downloads.md)*

## install: a new mod

1. The mod staged with its `meta.ini` written first, then one rename into `mods/`, so the folder is
   never seen half built. *diagram*
2. The root detected: a `Data/` folder, or plugins and meshes at the root, both install the same.
   *ruling*
3. A FOMOD detected and flagged for manual setup, not run. *ruling*
4. A new mod whose folder exists refused, naming the mod and pointing at upgrade. *ruling: refuse, never silently destroy*

## install: over an installed mod

1. To pick the target from the installed mods that share the download's Nexus mod ID, or to install a
   new mod. *catalog Meaning; the pick is in [downloads.md](../surfaces/downloads.md)*
2. The target confirmed every time, pre-selected by file ID and never by file name. *diagram header*
3. The folder's contents replaced in place, with its `.git` kept, and the folder never renamed, so its
   identity, its repository and its watchers survive. *diagram*
4. `meta.ini` to reflect the new download, with the installed file IDs recorded. *diagram*
5. A target whose folder has gone refused, naming it. *A gone object is refused*
6. A tracked mod to go on to the external-change question, with the new baseline pre-selected because
   the version moved. *diagram header; ADR-0003, invariant 3;
   [decompile-plugin_draft.md](decompile-plugin_draft.md)*

## Test seam

- **The driving box** (Downloads, Mods): the source, the target pick, the name prompt, and Esc.
- **The install box:** given a source and a target, what it asks the Instance adapter to stage, rename, remove and
  write, or the refusal.

The external-change question is tested in
[decompile-plugin_draft.md](decompile-plugin_draft.md).

## Open Questions

1. **Enabled or disabled.** Does a new mod start disabled? The old spec says yes. MO2's own install
   lands a mod and then sets its priority. Not written above.
2. **Where the new line goes.** The old spec says "at the bottom". The catalog has a planned position
   Option. ADR-0017 says the top of `modlist.txt` is the winning end.
3. **Cross-volume staging.** The old spec refuses it and never copies silently. Accept? It touches the
   deployment design session.
4. **Rollback on an upgrade.** Shared story 4 holds the principle. The old spec cannot roll back once
   the first file is removed, and names the folder and what remains. How an upgrade keeps the promise
   is design work for the workup.
5. **Which `meta.ini` keys change.** The old spec replaces the keys install owns and keeps the old value
   for a key the download does not know, so an unknown version never blanks a known one. Rule or
   detail?
6. **Fallback pre-selection.** The diagram says "by file id". The old spec adds a fallback to the
   recorded installation file, and `downloads.md` has it. Which is right?
7. **The name checked twice.** The old spec checks the name at the prompt against `modlist.txt`, and
   again at install against the disk, which also finds folders no line mentions. Rule or detail?
8. **Reinstall and the installer choice.** Reinstall from the recorded archive, and quick, manual or
   FOMOD, are planned in the catalog.
9. **The `Everything` preset.** An upgrade overwrites tracked assets as working-tree changes. Does that
   need a warning?
10. **Does the tracked mod's question ask?** The diagram draws the dialog. The decompile contract says
    whether it asks is open.
