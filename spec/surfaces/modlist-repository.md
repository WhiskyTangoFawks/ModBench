# Modlist repository

The modlist repository is what git holds of an instance: each mod's manifest, the profiles, the mod manager's configuration and the publisher's configuration. Update manifest writes a mod's manifest from its folder, and restore from manifest makes the folder what the manifest says ([ADR-0022](../adr/0022-a-mod-is-restored-from-its-manifest.md)). I commit, diff, branch and merge the source in Source Control as I would any source. Its gestures are in [commands.md](commands.md): git init under Modlist, update manifest and restore from manifest under Mod. What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The repository

As a user, I want:

1. The instance folder to be the repository, so a change I make in the mod manager or in Modbench is a working-tree change in Source Control. Cites: ADR-0022
2. The ignore list to be a whitelist: every manifest, each profile's mod order, plugin order and game INIs, the mod manager's configuration, the publisher's configuration, `.gitmodules`, and each source mod with a remote. Everything else is ignored: each mod's metadata, the downloaded files' index and each source mod with no remote included.
3. Every mod, every separator and every profile in the commit, enabled or not. A disabled mod is still mine.
4. No path true only on this machine in the repository, and a clone that runs with no edit, on Windows or Linux. A path into my instance folder, game folder or downloads folder, and no other folder, is held by a token, and the working tree holds this machine's path. A path the mod manager or the publisher writes on its own outside those folders, and my name and accounts, never reach a remote. Git init sets the tokens up, and restore does the same on a clone. Update manifest reports each other path a committed file holds, naming the file, and leaves the commit to me. Cites: Existing tools; Never silently wrong; Windows and Linux alike
5. Commit, diff, history, branches and merge to be VS Code's. Modbench adds no gesture for them. Cites: Existing tools
6. A push of the modlist refused while a commit it pins for a source mod is missing from that source mod's remote, so a clone can fetch every source mod. Git init makes the repository refuse such a push, and restore does the same on a clone. Cites: Existing tools; Never silently wrong

## The manifest

A mod folder has one package ([ADR-0023](../adr/0023-a-mod-folder-has-only-one-package.md)). A mod's installation file is the downloaded file the mod's metadata names as what the mod was installed from. As a user, I want:

1. One manifest in each mod folder, named for the mod, so a mod installed, uninstalled or renamed reads as a file added, removed or renamed in a diff, and two branches that change two mods merge. A source mod's manifest is in its repository instead. Cites: ADR-0022
2. The manifest to name the mod's installation file with its size and its hash, so an installation file that is corrupt or another version reads as one. Then the manifest lists each of the mod's own files with where it comes from in the package, that its package holds it with other bytes, or that its package does not hold it. Cites: ADR-0023
3. A file's line to name its path in the package only when that path differs from its path in the mod, as a FOMOD install moves files, so the ordinary line is the short one.
4. A file to come only from the mod's package, with the bytes the package holds. A file the package does not yield with its bytes is one its package holds with other bytes when the package has a file at its path, and otherwise one its package does not hold. So a file I edited reads apart from a file I added. Cites: ADR-0023
5. A file's line to carry no hash, because its package fixes its bytes, or a build makes them (Restore from manifest, story 5), so an upgrade reads in the diff as the installation file's line and the lines of the files it added, moved or dropped.
6. An excluded file to come back excluded: its line carries its name as the mod manager marks it, as MO2's `.mohidden` suffix. Cites: MO2
7. A source mod's manifest to name the installation files its build reads, never other installed mods, and list each file the build writes with the package it comes from. With no remote, its repository has no host, so a clone cannot fetch it. Cites: ADR-0022; ADR-0023
8. The manifest to hold no path from this machine, so a clone rebuilds anywhere.
9. Each separator to have a manifest that names nothing, so a clone has the separator. Cites: Never break the instance for its owner
10. The manifest to hold the mod's version beside its installation file's page on its host, so it holds all that restore writes into the mod's metadata. Cites: Never break the instance for its owner
11. The mod's metadata, where the mod manager keeps it in the mod folder, to be no file of the mod: no line names it, status never says it differs, and restore never sends it to the trash. Cites: Orthogonality
12. The manifest to be a JSON file that I review in git. It has one line for each package, one for each file and one for each step, the files in alphabetical order, so a diff shows what changed and nothing else. Cites: Existing tools
13. The manifest to name the installation file by its page on its host, such as the file's page on Nexus, so I can read it in a diff and open it.
14. A mod from the game folder to differ only when a file it takes changes, never when the game folder gains or changes a file the mod does not take. Cites: ADR-0023
15. A mod from the game folder to name the game folder as its package, never to leave its package unnamed. A mod is from the game folder when its metadata names no installation file and the game folder holds each of its files with their bytes. Cites: ADR-0023
16. Each manifest to be `<mod>.manifest.json`, so VS Code opens it as JSON and the ignore list never matches a mod's own files. Cites: Existing tools
17. Any manifest to hold the steps that build its mod folder, in the order they run, and a file a step makes to say so. I write the steps, update manifest keeps them, and restore runs them. Cites: ADR-0022

## Status

As a user, I want:

1. Each mod row to say, while the instance has a repository, differs when its folder differs from its manifest, or no manifest when it has none. A folder differs when a file's bytes differ from the manifest's, when it holds a file no line names, or when a file a line names is gone. Cites: Never silently wrong
2. A mod to say so, with the count, when its package does not hold a file, holds a file with other bytes, or has no host, so I see what a clone cannot rebuild before I commit. Cites: Never silently wrong
3. Status to cost a stat of each file, and a hash only of a file whose size, modified time or change time differs from Modbench's last read. A tool can keep a file's modified time, and a write always moves its change time. Modbench keeps what it last read on this machine and never commits it, as git keeps its index, so a clone on another machine reads a file as differing only when its bytes do. Cites: Existing tools; ADR-0003
4. Each file row in a mod to say differs when its bytes differ from the manifest's or no line names it, and the mod's tooltip to say how many files its manifest names and its folder lacks.
5. The Mods view's badge to count the mods that differ or have no manifest. Cites: VS Code's view badge
6. A mod to say differs when its metadata differs from its manifest in the version or its installation file's page on its host, so a change I make in the mod manager reaches the commit. Cites: Never silently wrong
7. A separator to say differs or no manifest as a mod does, and to count in the badge. Cites: Never silently wrong

## Git init

As a user, I want:

1. No prompt. Git init makes the repository with its ignore list and writes no manifest, so Source Control shows the profiles and the mod manager's configuration as untracked, and no mod, until I update the manifests, stage and commit. Cites: catalog `git init`
2. Git init on an instance folder that already holds a repository to adopt it: it adds the ignore list, the push check and the path tokens, and keeps the repository's history, remotes and tracked files. Cites: Existing tools
3. Source Control, while the instance folder holds no repository, to offer git init beside git's own Initialize Repository, and to say that git init writes the ignore list, so git never reads the mod folders' files. Cites: VS Code's Source Control welcome content

## Every mod

As a user, I want:

1. Update manifest and restore from manifest with no mods to act on every mod and every separator in the instance, in every profile, enabled or not. The Mods view shows the active profile alone and what a filter leaves, so select all there is not every mod. Cites: The repository, story 3
2. From the palette, the Mods view's selection when that view has focus, else every mod. Cites: catalog, The surface supplies the Argument
3. A separator in a selection to stand for itself and its mods, so a collapsed group acts whole. Cites: mods.md, The tree, story 2
4. Each mod to land on its own: a refused or skipped mod never stops the rest. Cites: A selection is one gesture, and each item lands on its own
5. Progress by mod, with Cancel. Cancel stops after the mod in hand, and the mods that landed stay. Cites: VS Code's progress notification

## Update manifest

As a user, I want:

1. Update manifest to write only what changed, so an unchanged mod changes nothing and Source Control holds only what I did. Cites: plugin-source.md, The tree, story 2
2. No confirmation. The manifests are derived from the mods, and git holds what update manifest replaces. This is an exception to Confirm what destroys.
3. A mod refused when its installation file is not in the downloads folder, naming the mod and the file, and its manifest left as it was. The other mods land. Cites: Never silently wrong
4. A file its package does not hold, or holds with other bytes, written as such and reported, so the gap is in the diff and the rest of the modlist commits. Cites: Never silently wrong
5. A source mod's manifest left to me and its build, and the mod reported when its folder differs from what the build wrote. Cites: ADR-0022
6. It stages nothing and commits nothing. Cites: Existing tools
7. A file whose stat matches Modbench's last read not hashed again, so an update after an update reads nothing. Cites: Status, story 3
8. One line when it lands: how many mods were unchanged, updated and refused, how many files their packages do not hold, and how many files their packages hold with other bytes, with each refused mod and each such file in the Output. This report is the modlist's validation. Cites: common, Reporting
9. Each source mod with a remote to become a submodule of the repository, and I run no submodule command. Update manifest writes the source mod's entry in `.gitmodules`, with its remote and its branch, and its line in the ignore list. Source Control then shows the source mod as a change, and my stage and commit record it. A source mod that is gone loses its entry and its line. Cites: ADR-0023

## Restore from manifest

As a user, I want:

1. Each mod's folder to become what its manifest says: every file whose bytes differ written, and every file no line names sent to the trash. A file whose bytes already match is left alone, so a restore after a checkout costs only what the checkout changed. Cites: ADR-0022
2. One confirmation, only when the restore destroys something: a file whose bytes differ from the manifest's, a file no line names, or metadata whose version or installation file's page on its host differs from the manifest's. It names the mods, or says every mod, and says that a change no manifest holds is lost. A restore after a fresh clone asks nothing. Cites: Confirm what destroys
3. A source mod with a remote rebuilt from its submodule at the commit the repository pins and the installation files its manifest names, and the submodule cloned when it is absent. When the branch the submodule follows is at that commit, restore checks out the branch, so I land on a branch. One at another commit is skipped and named with the commit, because Modbench never moves my repository. Cites: ADR-0023; ADR-0003
4. A mod skipped, and named with what it lacks, when an installation file or a game file its manifest names is missing or has other bytes, or when its package does not hold a file, holds a file with other bytes, or has no host. An installation file story 10 downloads is not missing. Every other mod lands. Cites: A selection is one gesture, and each item lands on its own
5. A file the build makes, a compiled plugin or a packed archive, to come back as the build makes it, which can differ in bytes. Only what comes from the installation file or the game folder is byte-checked. Cites: ADR-0006
6. A restore interrupted part way to say so, naming the mods it did not finish. Restoring again is the recovery. This is an exception to A failed gesture writes nothing. Cites: mods.md, What install does, story 5
7. A mod folder with no manifest left as it is and named in the report, because it can be a mod I have not recorded yet. Uninstall removes it. Cites: Never silently wrong
8. Restore to find each mod's files from its manifest alone, never from the mod's metadata, so a clone restores under a mod manager whose metadata git does not hold. Restore finds the installation file the manifest names by its name in the downloads folder. Cites: Orthogonality; ADR-0022
9. Restore to write each mod's metadata from its manifest, and to keep what the metadata holds that the manifest does not. Notes, colour and category stay on the machine that set them: they are Metadata chrome. Cites: Never break the instance for its owner; commands.md, Metadata chrome
10. An installation file the downloads folder lacks, whose page on Nexus the manifest names, downloaded from Nexus while I am logged in, refused when it is not the file the manifest names, and its metadata written as MO2 writes it. A clone then restores with no file fetched by hand. Cites: Minimal by default
11. Source mods built in the order Build gives when it builds more than one. Cites: mods.md, Build, story 12

## Menus and keys

Update manifest and restore from manifest sit in the Mods view for a selection, and in Source Control and the Toolbox for every mod.

| Where | Items, in order |
|---|---|
| Mods view, Mod and Separator menus | update manifest · restore from manifest… ([mods.md](mods.md)) |
| Mods view, title bar overflow | update manifest · restore from manifest…, on every mod |
| Source Control view, title bar overflow | update manifest · restore from manifest…, on every mod |
| Source Control view, welcome content with no repository | git init (Git init, story 3) |
| Toolbox, Modlist menu | git init, with no repository or one git init has not set up · update manifest · restore from manifest…, on every mod |

Each item but git init shows while the instance has a repository.

## Reporting

By [common.md](common.md#reporting). As a user, I want a refused or skipped mod named with its reason, the mods that landed not reported as failed, and the Toolbox's message line to name the gesture and its phase while one runs, with the view's progress bar until the read that follows lands. Cites: A selection is one gesture, and each item lands on its own; common, A gesture that writes, story 1

## Deferred

What I expect to need and choose not to build yet, each with why.

1. Deltas: a file whose bytes differ from its installation file's copy recorded as a binary diff from that copy, so the modlist rebuilds a mod I changed. ADR-0022 ships a change as a patch instead. The one job only a delta does is an official master cleaned with xEdit, rebuilt from the game's own file.
2. A hash on every file's line. With no deltas, the installation file's hash and the path fix a file's bytes.
3. Fetching an installation file from a host other than Nexus. Restore from manifest names what it lacks, and I fetch it.
4. Which side changed: a mark of the manifest each folder was last restored from, so a mod reads as changed by a checkout or by me, and a checkout restores in one click. I know whether I pulled or edited.
5. A gesture that validates the modlist and writes nothing, for a CI job. Update manifest's report is the validation.
6. An archive built in a mod from its installation file's files, each entry with a line of its own naming its path in the installation file, so a change to one entry is one line in a diff.

## Test seam

- The manifest, given a mod folder's files and its package: the lines, with no git and no VS Code.
- Restore from manifest, given manifests, the downloaded files, the game folder and the submodules: the files written, the files sent to the trash, each mod's metadata written, and the mods skipped with their reasons.
- Status, given manifests, a folder and what Modbench last read: each mod's state, with no hash computed for a file whose size and time match.
- The round trip: update manifest then restore from manifest on a fixture instance changes no file.
- Menus and keys: the placement above, checked against the extension manifest.
