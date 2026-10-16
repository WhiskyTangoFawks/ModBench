# A mod folder has only one source

A mod folder is one source unpacked through a selection: one installation file, the game folder, or a source mod's repository. Its manifest names that source once and pins it, and lists every file of the folder by where it sits in that source, so a FOMOD's choices restore as they were made, and a source that changed without the user's knowledge reads as changed. One source per folder is how a mod ships and how a mod manager installs it, and it keeps a folder's origin one fact the user reviews in a diff (principles: Never silently wrong; Minimal by default).

## Consequences

- A second download merged into a folder, or a file dropped into it, has no provider, and the manifest says so. The user installs it as a mod of its own, or ships it in a source mod, so each folder's origin stays one fact.
- The game folder is pinned by a hash of the files the mod takes from it, never of the whole folder, because the game folder holds files no mod takes, and they change while the mod does not.
- A source mod's repository is a git submodule of the instance repository, because git already pins one repository inside another (principles: Existing tools). Git holds its remote, the commit the modlist builds and the branch an update follows, so a commit in a source mod changes one line in the instance repository and no line of its manifest.
- A source mod with no remote is no submodule. A clone cannot fetch its source, so its manifest says each file has no provider.
- Restore clones an absent submodule, and never moves one that is at another commit. It names the mod and the commit instead.

## Alternatives rejected

- A source for each file, as Wabbajack records it. It records any folder, a merged install included, but every line repeats its source, and a folder's origin is many facts, not one.
- The manifest pins a source mod by its remote and commit. Each commit then rewrites every line the source provides, and Modbench maintains what git's submodules already do.
- The manifest pins a source mod by a branch. A branch moves, so two clones of one commit build two different mods.
