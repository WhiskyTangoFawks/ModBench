# A mod folder has only one package

A mod folder is one package unpacked through a selection: one installation file, the game folder, or a source mod's repository. Its manifest names that package once and pins it. It lists every file of the folder with where it comes from in that package. So a FOMOD's choices restore as they were made, and a package that changed without the user's knowledge reads as changed. One package per folder is how a mod ships and how a mod manager installs it, and it keeps where a folder comes from one fact the user reviews in a diff ([principles](../principles.md): Never silently wrong; Minimal by default).

## Consequences

- A second downloaded file merged into a folder, or a file dropped into it, is a file its package does not yield, and the manifest says so. The user installs it as a mod of its own, or ships it in a source mod, so where each folder comes from stays one fact.
- The game folder is pinned by a hash of the files the mod takes from it, never of the whole folder, because the game folder holds files the mod does not take, and they change while the mod does not.
- A source mod's repository is a git submodule of the instance repository, because git already pins one repository inside another ([principles](../principles.md): Existing tools). Git holds its remote, the commit the modlist builds and the branch an update follows, so a commit in a source mod, its manifest included, changes one line in the instance repository.
- A source mod's repository is its one package. Its manifest, in that repository, pins the installation files its build reads, never other installed mods, so its commit still fixes where its folder comes from.
- A source mod with no remote is no submodule. Its package has no host, so a clone cannot fetch it, and the manifest says so.
- Restore clones an absent submodule, and never moves one that is at another commit.

## Alternatives rejected

- A package for each file, as Wabbajack records it. It records any folder, a merged install included, but every line repeats its package, and where a folder comes from is many facts, not one.
- The manifest pins a source mod by its remote and commit. Each commit then rewrites every line the source provides, and Modbench maintains what git's submodules already do.
- The manifest pins a source mod by a branch. A branch moves, so two clones of one commit build two different mods.
