# Modlist repository

The modlist repository is what git holds of an instance (The repository, story 2). Its gestures are in [commands.md](commands.md). What every view shares is in [common.md](common.md).

Each story cites what decides it. A story that cites nothing is owned here.

## The repository

As a user, I want:

1. The instance folder to be the repository, so a change I make in the mod manager or in Modbench is a working-tree change in Source Control. Cites: ADR-0022
2. The repository to hold what a clone needs to rebuild my instance, and nothing else.
3. A clone that runs with no edit on any machine, Windows or Linux. Modbench makes the paths in the files the repository holds by default portable, with no step of mine. Cites: Windows and Linux alike
4. Commit, diff, history, branches and merge to be VS Code's. Modbench adds no gesture for them. Cites: Existing tools
5. A push never to publish a modlist a clone cannot fetch. Cites: Never silently wrong
6. My name and accounts never to reach a remote.

## The manifest

A mod's installation file is the downloaded file the mod's metadata names as what the mod was installed from. As a user, I want:

1. The manifest to be a build file that restores its folder's contents from its packages, on any machine. Cites: ADR-0022
2. A change to my modlist to read in a git diff as the change I made, so I review and merge it as source. Cites: Existing tools
3. Restore to give the mod manager back what it had. Cites: Never break the instance for its owner
4. Each package named with where a clone gets it, so a clone fetches what this machine lacks.

## Status

As a user, I want:

1. Each mod, separator and file in a mod to say, while the instance has a repository, differs when it or its metadata differs from its manifest, or no manifest when it has none, so a change I make in the mod manager reaches the commit. Cites: Never silently wrong
2. Each state in which my modlist would not rebuild my instance as it is, on any machine, in the Problems panel while it holds, on the file it concerns, so nothing I leave unfinished goes unseen. Cites: common, Reporting; Never silently wrong
3. Status to cost only what changed since Modbench last read it on this machine, and a clone to read a file as differing only when its bytes do. Cites: ADR-0003
4. The Mods view's badge to count the mods and separators that differ or have no manifest. Cites: VS Code's view badge

## Git init

As a user, I want:

1. Git init to make the instance folder a modlist repository with no prompt, or to adopt the repository it holds and keep its history, remotes and tracked files. It writes no manifest and commits nothing. Cites: catalog `git init`; Existing tools
2. Source Control, while the instance folder holds no repository, to offer git init beside git's own Initialize Repository, and to say that git init keeps the mod folders' files out of git. Cites: VS Code's Source Control welcome content

## Every mod

As a user, I want:

1. Update manifest and restore from manifest to run where I run them: on the folders I select, or with none selected on every manifest in the instance, not only those the Mods view shows.
2. A separator in a selection to stand for itself and its mods, so a collapsed group acts whole. Cites: mods.md, The tree, story 2
3. Progress by mod, with Cancel. Cancel stops after the mod in hand, and the mods that landed stay. Cites: VS Code's progress notification

## Update manifest

As a user, I want:

1. An update manifest gesture that writes the manifest of a folder, and creates it when the folder has none.
2. Update manifest to write only what changed, so an unchanged mod changes nothing and Source Control holds only what I did. Cites: plugin-source.md, The tree, story 2
3. It stages nothing and commits nothing. Cites: Existing tools
4. Update manifest, while it hashes downloaded files, to show progress and to stop when I cancel, keeping each hash it took. A downloaded file whose hash failed is hashed again after a reload of the window, so a tool I fix takes effect.
5. A mod refused, and its manifest left as it was, when a package it is made from is missing from this machine, so a missing download never reads as files no package holds. Cites: Never silently wrong

## Restore from manifest

As a user, I want:

1. Each folder to become what its manifest says, with each file restore removes sent to the trash. A file that already matches is left alone, so a restore after a checkout costs only what the checkout changed. Cites: ADR-0022
2. One confirmation, only when the restore destroys a change no manifest holds, naming the mods or saying every mod. A restore after a fresh clone asks nothing. Cites: Confirm what destroys
3. A source mod left on its branch when the branch is at the commit the repository pins, so I land on a branch. Cites: ADR-0022; ADR-0003
4. Each package taken from wherever this machine already holds it with the bytes the manifest pins, and fetched only when it does not: an installation file from Nexus while I am logged in, refused when it is not the file the manifest names. A clone then restores with no file fetched by hand. Cites: Minimal by default
5. A restore interrupted part way to say so, naming the mods it did not finish. Restoring again is the recovery. Cites: mods.md, What install does, story 5

## Menus and keys

| Where | Items, in order |
|---|---|
| Mods view, Mod and Separator menus | update manifest · restore from manifest… ([mods.md](mods.md)) |
| Mods view, title bar overflow | update manifest · restore from manifest…, on every manifest |
| Source Control view, title bar overflow | update manifest · restore from manifest…, on every manifest |
| Source Control view, welcome content with no repository | git init (Git init, story 2) |
| Toolbox, Modlist menu | git init, with no repository or one git init has not set up · update manifest · restore from manifest…, on every manifest |

Each item but git init shows while the instance has a repository.

## Reporting

By [common.md](common.md#reporting). As a user, I want:

1. Update manifest's one line when it lands, counting what changed and what a clone cannot rebuild, with each refused mod and each such file in the Output. Cites: Minimal by default
2. The Toolbox's message line to name the gesture and its phase while one runs.

## Deferred

What I expect to need and choose not to build yet, each with why.

1. Deltas: a file whose bytes differ from its installation file's copy recorded as a binary diff from that copy, so the modlist rebuilds a mod I changed. ADR-0022 ships a change as a patch instead. The one job only a delta does is an official master cleaned with xEdit, rebuilt from the game's own file.
2. Fetching an installation file from a host other than Nexus, or a game's files from its store, such as a Steam depot. Restore from manifest names what it lacks, and I fetch it.
3. Which side changed: a mark of the manifest each folder was last restored from, so a mod reads as changed by a checkout or by me, and a checkout restores in one click. I know whether I pulled or edited.
4. A gesture that validates the modlist and writes nothing, for a CI job. Update manifest's report is the validation.
5. An archive built in a mod from its installation file's files, so a change to one entry reads as that entry in a diff.
6. An external tool that needs the load order, such as xEdit, run by a step. It reads a data folder, so it waits for a deploy.
7. A count in the status bar of the folders that differ from their manifests, each named in its tooltip, so a folder that is not a mod shows that it differs. A mod's row already says so, and no goal yet needs the rest.
8. Restore as a VS Code task. No chain of mine runs it (commands.md, A task is an entry point for a chain).

## Test seam

- The manifest, given a folder's files and its packages: the lines, with no git and no VS Code.
- Restore from manifest, given manifests, the downloaded files, the game folders and the submodules: the files written, the files sent to the trash, each mod's metadata written, and the mods skipped with their reasons.
- Status, given manifests, a folder and what Modbench last read: each mod's state, with no hash of a file that has not changed.
- The round trip: update manifest then restore from manifest on a fixture instance changes no file.
- Menus and keys: the placement above, checked against the extension manifest.
