# Modlist source

The modlist source is what git holds of an instance: each mod's manifest, the profiles and the mod manager's configuration. Restore rebuilds a mod from its manifest ([ADR-0022](../../adr/0022-a-mod-is-restored-from-its-manifest.md)), and I commit, diff, branch and merge the source in Source Control as I would any source. Its template is Wabbajack ([ADR-0023](../../adr/0023-wabbajack-is-the-reference-for-the-manifest-git-for-its-gestures.md)); where it departs, [wabbajack.md](../../out-of-scope/wabbajack.md) says why. Its gestures are in [commands.md](../commands.md) under Modlist. The Toolbox offers them ([toolbox.md](toolbox.md)), and restore is also on a mod's row ([mods.md](mods.md)). What every view shares is in [common.md](common.md).

Each story cites its source. A story with no source is owned here.

## The repository

As a user, I want:

1. The instance folder to be the repository, so a change I make in the mod manager or in Modbench is a working-tree change in Source Control. Source: ADR-0022
2. The ignore list to be a whitelist: every manifest, each mod's `meta.ini`, each profile's mod order, plugin order and INIs, and the mod manager's configuration. Everything else is ignored, the build folder and the source folder included.
3. Every mod and every profile in the commit, enabled or not. A disabled mod is still mine. Source: wabbajack.md, divergence 1
4. The mod manager's configuration committed with the paths it holds. A clone on another machine edits them. Source: wabbajack.md, divergence 9
5. Commit, diff, history, branches and merge to be VS Code's. Modbench adds no gesture for them. Source: Existing tools

## The manifest

A mod's installation files are the downloaded files the mod manager records the mod as installed from. As a user, I want:

1. One manifest in each mod folder, named for the mod, so a mod installed, uninstalled or renamed reads as a file added, removed or renamed in a diff, and two branches that change two mods merge. Source: ADR-0022; wabbajack.md, divergence 2
2. The manifest to name the mod's installation files and the game files its files come from, each with its size, its hash and where the mod manager says it comes from, and then one line for each file in the mod folder. Source: Wabbajack's archives and directives
3. A file's line to say nothing when the first installation file holds it at the same path, so the ordinary case is the short one. Otherwise it names the path inside an installation file, the delta that makes it, or that it has no source.
4. A file to come only from the mod's installation files or from the game folder. A file none of them yields has no source. Source: wabbajack.md, divergences 3 and 4
5. A file whose bytes differ from an installation file's copy to be a delta from that copy, and a plugin cleaned from the game's own to be a delta from the game file. Source: Wabbajack's patched files
6. A delta larger than a share of its file, which I set, to count as no source, because a delta that size is the file. Source: ADR-0022
7. An excluded file to restore excluded: its line carries its full name, `.mohidden` included. Source: MO2
8. A source mod's manifest to be what its last build wrote. With a remote, each file the source provides names the remote and the commit; with none, the manifest reads as an mod with no source's, with deltas. Source: ADR-0022
9. The manifest to hold no path from this machine, so a clone restores anywhere. Source: Wabbajack

## Deltas

As a user, I want:

1. Update to write each delta, for an mod with no source or a source mod with no remote, as a build output in a build folder at the instance root that git ignores, never in the downloads folder.
2. A delta's name to carry the file it makes and the hashes of both ends, so a file edited again gets a new delta, every older commit keeps a valid one, and I can tell what a delta is from its name. Source: ADR-0022
3. To publish deltas as I choose, one by one or packed, and nothing of Modbench to pack or upload them. Source: ADR-0022; wabbajack.md, divergence 5
4. Restore to find a delta by its name: in the build folder, loose in the downloads folder, or inside any downloaded file. The manifest says nothing of where I put it, so repacking changes no manifest.

## Track

As a user, I want:

1. No prompt. Track creates the repository with its ignore list, writes every manifest as update writes them, and makes one commit, `Track modlist`. Source: catalog `track`; plugins.md, Track
2. Track refused when the instance folder already holds a repository, naming it. Source: Refuse, do not repair
3. A mod update refuses to be named, and the commit to hold every other manifest. Source: Update, story 3

## Update

As a user, I want:

1. Update to write only what changed, so an unchanged mod changes nothing and the diff holds only what I did. Source: plugin-source.md, The tree, story 2
2. No confirmation. The manifests are derived from the mods and git holds what update replaces. This is an exception to Confirm what destroys.
3. A mod refused when one of its installation files is not in the downloads folder, naming the mod and the file, and its manifest left as it was. The other mods land. Source: wabbajack.md, divergence 6; A selection is one gesture, and each item lands on its own
4. A file with no source written as such and reported, so the gap is in the diff and the rest of the modlist commits. Source: wabbajack.md, divergence 4
5. It commits nothing. Source: catalog `update`
6. A source mod's manifest left to its build, and the mod reported when its folder differs from what the build wrote. Source: ADR-0022

## Restore

As a user, I want:

1. Restore to make each mod's folder match its manifest: every file the manifest names, with the bytes it fixes. A file the manifest does not name is removed. With no Argument, every mod, and a mod folder with no manifest goes to the trash, as uninstall sends it. With mods as its Argument, those mods only. A source mod with a remote is built from its source at the commit the manifest names, and the source is cloned when it is absent. Source: ADR-0022; wabbajack.md, divergences 8 and 11
2. One confirmation, saying that restore replaces the mods from their manifests and that a change not updated and committed is lost. It names the mods when I selected some, and each mod folder the manifest does not name, since those go to the trash. It says when the manifests have uncommitted changes. Source: Confirm what destroys
3. A mod skipped, and named with what it lacks, when an installation file, a delta or a game file its manifest names is missing or has other bytes, or when a file has no source. Every other mod restores. Restore downloads nothing. Source: wabbajack.md, divergence 7; A selection is one gesture, and each item lands on its own
4. Every file restore writes to have the bytes the manifest fixes, or restore says which did not. Source: Never silently wrong; Wabbajack checks every file it writes
5. A restore interrupted part way to say so, naming the mods it did not finish. Restoring again is the recovery. This is an exception to A failed gesture writes nothing. Source: mods.md, What install does, story 5
6. The views to show the result as they show any change on disk. Source: common, A view, story 2
7. A source mod whose source is present at another commit skipped and named with the commit, because restore never moves my repository. Source: ADR-0022; ADR-0003
8. A file the build makes, a compiled plugin or a packed archive, restored to what the build makes, which can differ in bytes. Restore checks the bytes of what comes from downloaded files. Source: ADR-0006

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. A refused or skipped mod named with its reason, and the mods that landed not reported as failed. Source: A selection is one gesture, and each item lands on its own
2. The Toolbox's message line to name the gesture and its phase while one runs, and the view's progress bar until the read that follows lands. Source: plugins.md, Track, story 1; common, A gesture that writes, story 1

## Test seam

- The manifest, given a mod folder's files, its installation files and the game folder: the lines and the deltas, with no git and no VS Code.
- Restore, given a manifest and the downloaded files: the files written, the files removed, and the mods skipped with their reasons.
- The round trip: update then restore on a fixture instance changes no file, and an edited file comes back through its delta.
- Menus and keys: the placement in toolbox.md and mods.md, checked against the extension manifest.
