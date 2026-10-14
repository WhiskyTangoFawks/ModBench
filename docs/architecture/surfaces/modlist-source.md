# Modlist source

The modlist source is what git holds of an instance: each mod's manifest, the profiles and the mod manager's configuration. Update manifest writes a mod's manifest from its folder, and restore from manifest makes the folder what the manifest says ([ADR-0022](../../adr/0022-a-mod-is-restored-from-its-manifest.md)). I commit, diff, branch and merge the source in Source Control as I would any source. Its template is Wabbajack ([ADR-0023](../../adr/0023-wabbajack-is-the-reference-for-the-manifest-and-its-gestures.md)); where it departs, [wabbajack.md](../../out-of-scope/wabbajack.md) says why. Its gestures are in [commands.md](../commands.md): git init under Modlist, update manifest and restore from manifest under Mod. What every view shares is in [common.md](common.md).

Each story cites its source. A story with no provider is owned here.

## The repository

As a user, I want:

1. The instance folder to be the repository, so a change I make in the mod manager or in Modbench is a working-tree change in Source Control. Source: ADR-0022
2. The ignore list to be a whitelist: every manifest, each mod's `meta.ini`, each profile's mod order, plugin order and INIs, and the mod manager's configuration. Everything else is ignored, the downloaded files' index and the source folder included.
3. Every mod and every profile in the commit, enabled or not. A disabled mod is still mine. Source: wabbajack.md, divergence 1
4. The mod manager's configuration committed with the paths it holds. A clone on another machine edits them. Source: wabbajack.md, divergence 9
5. Commit, diff, history, branches and merge to be VS Code's. Modbench adds no gesture for them. Source: Existing tools

## The manifest

A mod's installation files are the downloaded files the mod manager records the mod as installed from. As a user, I want:

1. One manifest in each mod folder, named for the mod, so a mod installed, uninstalled or renamed reads as a file added, removed or renamed in a diff, and two branches that change two mods merge. Source: ADR-0022; wabbajack.md, divergence 2
2. The manifest to name the mod's installation files and the game files its files come from, each with its size, its hash and where the mod manager says it comes from, and then one line for each file in the mod folder the repository does not commit, naming its provider: an installation file, the game folder or the mod's source. Source: Wabbajack's archives and directives
3. A file's line to say nothing when the first installation file holds it at the same path, so the ordinary case is the short one. Otherwise it names the path inside an installation file, or that it has no provider.
4. A file to come only from the mod's installation files or from the game folder, with the bytes they hold. A file none of them yields with its bytes has no provider. Source: wabbajack.md, divergences 3 and 4
5. A file's line to carry no hash, because its provider fixes its bytes, so an upgrade reads in the diff as the installation file's line and the lines of the files it added, moved or dropped.
6. An excluded file to come back excluded: its line carries its full name, `.mohidden` included. Source: MO2
7. A source mod's manifest to be what its last build wrote. With a remote, each file the source provides names the remote and the commit. With none, the manifest reads as any other mod's, and a file the installation files do not yield has no provider. Source: ADR-0022
8. The manifest to hold no path from this machine, so a clone rebuilds anywhere. Source: Wabbajack

## Status

As a user, I want:

1. Each mod row to say, while the instance has a repository, differs when its folder differs from its manifest, or no manifest when it has none. A folder differs when a file's bytes differ from the manifest's, when it holds a file no line names, or when a file a line names is gone. Source: Never silently wrong
2. A mod whose manifest has a file with no provider to say so, with the count, so I see what a clone cannot rebuild before I commit. Source: wabbajack.md, divergence 4
3. Status to cost a stat of each file, and a hash only of a file whose size, modified time or change time differs from Modbench's last read. A tool can keep a file's modified time, and a write always moves its change time. Modbench keeps what it last read on this machine and never commits it, as git keeps its index, so a clone on another machine reads a file as differing only when its bytes do. Source: Existing tools; ADR-0003
4. Each file row in a mod to say differs when its bytes differ from the manifest's or no line names it, and the mod's tooltip to say how many files its manifest names and its folder lacks.
5. The Mods view's badge to count the mods that differ or have no manifest. Source: VS Code's view badge

## Git init

As a user, I want:

1. No prompt. Git init makes the repository with its ignore list and writes no manifest, so Source Control shows each mod's `meta.ini`, the profiles and the mod manager's configuration as untracked, until I update the manifests, stage and commit. Source: catalog `git init`
2. Git init refused when the instance folder already holds a repository, naming it. Source: Refuse, do not repair
3. Source Control, while the instance folder holds no repository, to offer git init beside git's own Initialize Repository, and to say that git init writes the ignore list, so git never reads the mod folders' files. Source: VS Code's Source Control welcome content

## Every mod

As a user, I want:

1. Update manifest and restore from manifest with no mods to act on every mod folder in the instance, in every profile, enabled or not. The Mods view shows the active profile alone and what a filter leaves, so select all there is not every mod. Source: The repository, story 3
2. From the palette, the Mods view's selection when that view has focus, else every mod. Source: catalog, The surface supplies the Argument
3. A separator in a selection to stand for its mods, so a collapsed group acts whole. Source: mods.md, The tree, story 2
4. Each mod to land on its own: a refused or skipped mod never stops the rest. Source: A selection is one gesture, and each item lands on its own
5. Progress by mod, with Cancel. Cancel stops after the mod in hand, and the mods that landed stay. Source: VS Code's progress notification

## Update manifest

As a user, I want:

1. Update manifest to write only what changed, so an unchanged mod changes nothing and Source Control holds only what I did. Source: plugin-source.md, The tree, story 2
2. No confirmation. The manifests are derived from the mods, and git holds what update manifest replaces. This is an exception to Confirm what destroys.
3. A mod refused when one of its installation files is not in the downloads folder, naming the mod and the file, and its manifest left as it was. The other mods land. Source: wabbajack.md, divergence 6
4. A file with no provider written as such and reported, so the gap is in the diff and the rest of the modlist commits. Source: wabbajack.md, divergence 4
5. A source mod's manifest left to its build, and the mod reported when its folder differs from what the build wrote. Source: ADR-0022
6. It stages nothing and commits nothing. Source: Existing tools
7. A file whose stat matches Modbench's last read not hashed again, so an update after an update reads nothing. Source: Status, story 3
8. One line when it lands: how many mods were unchanged, updated and refused, and how many files have no provider, with each refused mod and each such file in the Output. This report is the modlist's validation. Source: common, Reporting

## Restore from manifest

As a user, I want:

1. Each mod's folder to become what its manifest says: every file whose bytes differ written, and every file no line names sent to the trash. A file whose bytes already match is left alone, so a restore after a checkout costs only what the checkout changed. Source: ADR-0022; ADR-0023
2. One confirmation, only when the restore destroys something: a file whose bytes differ from the manifest's, or a file no line names. It names the mods, or says every mod, and says that a change no manifest holds is lost. A restore after a fresh clone asks nothing. Source: Confirm what destroys
3. A source mod with a remote rebuilt from its source at the commit the manifest names, and the source cloned when it is absent. One at another commit is skipped and named with the commit, because Modbench never moves my repository. Source: ADR-0022; ADR-0003
4. A mod skipped, and named with what it lacks, when an installation file or a game file its manifest names is missing or has other bytes, or when a file has no provider. Every other mod lands. Nothing is downloaded. Source: wabbajack.md, divergence 7
5. A file the build makes, a compiled plugin or a packed archive, to come back as the build makes it, which can differ in bytes. Only what comes from a downloaded file is byte-checked. Source: ADR-0006
6. A restore interrupted part way to say so, naming the mods it did not finish. Restoring again is the recovery. This is an exception to A failed gesture writes nothing. Source: mods.md, What install does, story 5
7. A mod folder with no manifest left as it is and named in the report, because it can be a mod I have not recorded yet. Uninstall removes it. Source: Never silently wrong

## Menus and keys

Update manifest and restore from manifest sit in the Mods view for a selection, and in Source Control and the Toolbox for every mod.

| Where | Items, in order |
|---|---|
| Mods view, Mod and Separator menus | update manifest · restore from manifest… ([mods.md](mods.md)) |
| Mods view, title bar overflow | update manifest · restore from manifest…, on every mod |
| Source Control view, title bar overflow | update manifest · restore from manifest…, on every mod |
| Source Control view, welcome content with no repository | git init (Git init, story 3) |
| Toolbox, Modlist row | click: git init, with no repository ([toolbox.md](toolbox.md)) |
| Toolbox, Modlist menu | update manifest · restore from manifest…, on every mod |

Each item but git init shows while the instance has a repository.

## Reporting

By [common.md](common.md#reporting). As a user, I want a refused or skipped mod named with its reason, the mods that landed not reported as failed, and the Toolbox's message line to name the gesture and its phase while one runs, with the view's progress bar until the read that follows lands. Source: A selection is one gesture, and each item lands on its own; common, A gesture that writes, story 1

## Deferred

What I expect to need and choose not to build yet, each with why.

1. Deltas: a file whose bytes differ from its installation file's copy recorded as a binary diff from that copy, so the modlist rebuilds a mod I changed. ADR-0022 ships a change as a patch instead. The one job only a delta does is an official master cleaned with xEdit, rebuilt from the game's own file.
2. A hash on every file's line. With no deltas, the installation file's hash and the path fix a file's bytes.
3. Fetching an installation file by its hash from a remote, git or Nexus. Restore from manifest names what it lacks, and I fetch it.
4. Update manifest run by the gestures that change a mod: install, upgrade and uninstall. Minimal by default: I chain the gestures, then commit.
5. Which side changed: a mark of the manifest each folder was last restored from, so a mod reads as changed by a checkout or by me, and a checkout restores in one click. I know whether I pulled or edited.
6. A gesture that validates the modlist and writes nothing, for a CI job. Update manifest's report is the validation.

## Test seam

- The manifest, given a mod folder's files, its installation files and the game folder: the lines, with no git and no VS Code.
- Restore from manifest, given manifests and the downloaded files: the files written, the files sent to the trash, and the mods skipped with their reasons.
- Status, given manifests, a folder and what Modbench last read: each mod's state, with no hash computed for a file whose size and time match.
- The round trip: update manifest then restore from manifest on a fixture instance changes no file.
- Menus and keys: the placement above, checked against the extension manifest.
