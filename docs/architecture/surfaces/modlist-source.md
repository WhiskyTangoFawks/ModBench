# Modlist source

The modlist source is what git holds of an instance: each mod's manifest, the profiles and the mod manager's configuration. Discard changes rebuilds a mod from its manifest ([ADR-0022](../../adr/0022-a-mod-is-restored-from-its-manifest.md)), and I commit, diff, branch and merge the source in Source Control as I would any source. Its template is Wabbajack ([ADR-0023](../../adr/0023-wabbajack-is-the-reference-for-the-manifest-git-for-its-gestures.md)); where it departs, [wabbajack.md](../../out-of-scope/wabbajack.md) says why. Its gestures are in [commands.md](../commands.md) under Modlist, and their home is VS Code's Source Control view (Menus and keys). What every view shares is in [common.md](common.md).

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
7. An excluded file to come back excluded: its line carries its full name, `.mohidden` included. Source: MO2
8. A source mod's manifest to be what its last build wrote. With a remote, each file the source provides names the remote and the commit; with none, the manifest reads as an mod with no source's, with deltas. Source: ADR-0022
9. The manifest to hold no path from this machine, so a clone rebuilds anywhere. Source: Wabbajack

## Deltas

As a user, I want:

1. Stage to write each delta, for a mod that is not a source mod or a source mod with no remote, as a build output in a build folder at the instance root that git ignores, never in the downloads folder.
2. A delta's name to carry the file it makes and the hashes of both ends, so a file edited again gets a new delta, every older commit keeps a valid one, and I can tell what a delta is from its name. Source: ADR-0022
3. To publish deltas as I choose, one by one or packed, and nothing of Modbench to pack or upload them. Source: ADR-0022; wabbajack.md, divergence 5
4. Discard changes to find a delta by its name: in the build folder, loose in the downloads folder, or inside any downloaded file. The manifest says nothing of where I put it, so repacking changes no manifest.

## Status

As a user, I want:

1. Each mod to carry git's own status against its manifest, in git's letters and colours, while the instance has a repository: modified when a file's bytes differ from the manifest, untracked when the mod has no manifest or holds a file no manifest names, deleted when a file the manifest names is gone. Source: ADR-0023; plugins.md, A row, Badge
2. A mod to read stale when its manifest changed after its folder was last built or discarded, so a checkout or merge outside Modbench shows what it left behind. The Toolbox counts the stale mods. Source: ADR-0023
3. Status to cost a stat of each file, never a hash: the manifest carries each file's size and time beside its hash, and a file whose two match is trusted, as git's index trusts its own. Source: Existing tools

## Init

As a user, I want:

1. No prompt. Init makes the repository with its ignore list and stages nothing, so Source Control shows the whole instance as untracked until I stage and commit, as `git init` does. Source: catalog `init`
2. Init refused when the instance folder already holds a repository, naming it. Source: Refuse, do not repair

## Stage

As a user, I want:

1. Stage to write only what changed, so an unchanged mod changes nothing and Source Control holds only what I did. Source: plugin-source.md, The tree, story 2
2. No confirmation. The manifests are derived from the mods, and git holds what stage replaces. This is an exception to Confirm what destroys.
3. A mod refused when one of its installation files is not in the downloads folder, naming the mod and the file, and its manifest left as it was. The other mods land. Source: wabbajack.md, divergence 6
4. A file with no source written as such and reported, so the gap is in the diff and the rest of the modlist commits. Source: wabbajack.md, divergence 4
5. A source mod's manifest left to its build, and the mod reported when its folder differs from what the build wrote. Source: ADR-0022
6. It commits nothing. Source: catalog `stage`

## Discard changes

As a user, I want:

1. Every file a manifest names to come back with the bytes it fixes, and no other file touched. A file whose bytes already match is left alone, so a discard after a checkout costs only what the checkout changed. Source: ADR-0022; ADR-0023
2. One confirmation, as VS Code's Discard Changes asks, naming the mods when I selected some and saying that changes not staged and committed are lost. Source: Confirm what destroys; VS Code's interaction
3. A source mod with a remote rebuilt from its source at the commit the manifest names, and the source cloned when it is absent. One at another commit is skipped and named with the commit, because Modbench never moves my repository. Source: ADR-0022; ADR-0003
4. A mod skipped, and named with what it lacks, when an installation file, a delta or a game file its manifest names is missing or has other bytes, or when a file has no source. Every other mod lands. Nothing is downloaded. Source: wabbajack.md, divergence 7
5. A file the build makes, a compiled plugin or a packed archive, to come back as the build makes it, which can differ in bytes. Only what comes from a downloaded file is byte-checked. Source: ADR-0006
6. A discard interrupted part way to say so, naming the mods it did not finish. Discarding again is the recovery. This is an exception to A failed gesture writes nothing. Source: mods.md, What install does, story 5

## Clean

As a user, I want:

1. A listing first, of every untracked file and every mod folder with no manifest that clean would remove, and one confirmation, as `git clean -n` precedes `git clean -f`. Esc removes nothing. Source: Confirm what destroys; ADR-0023
2. The files and folders to go to the trash, never deleted. Source: ADR-0003

## Menus and keys

The home of stage, discard changes and clean is VS Code's Source Control view for the instance's repository. The Toolbox and the Mods view are entry points to the same gestures.

| Where | Items, in order |
|---|---|
| Source Control view, title bar overflow | stage · discard changes… · clean… |
| Source Control view, a manifest's row | discard changes in mod folder…, which discards that mod |
| Toolbox, Modlist row | the branch and the stale count; click: init, or discard changes on the stale mods ([toolbox.md](toolbox.md)) |
| Mods view, Mod menu | stage · discard changes… · clean… ([mods.md](mods.md)) |

As a user, I want the manifest row's item named for the mod folder, because git's own Discard Changes sits beside it and reverts the manifest's text. Source: Never silently wrong

## Reporting

By [common.md](common.md#reporting). As a user, I want a refused or skipped mod named with its reason, the mods that landed not reported as failed, and the Toolbox's message line to name the gesture and its phase while one runs, with the view's progress bar until the read that follows lands. Source: A selection is one gesture, and each item lands on its own; common, A gesture that writes, story 1

## Test seam

- The manifest, given a mod folder's files, its installation files and the game folder: the lines and the deltas, with no git and no VS Code.
- Discard changes, given manifests and the downloaded files: the files written, the files left, and the mods skipped with their reasons.
- Status, given manifests and a folder: each mod's letters and stale, with no hash computed.
- The round trip: stage then discard on a fixture instance changes no file, and an edited file comes back through its delta.
- Menus and keys: the placement above, checked against the extension manifest.
