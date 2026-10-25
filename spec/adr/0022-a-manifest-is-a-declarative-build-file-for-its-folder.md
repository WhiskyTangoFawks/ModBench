# A manifest is a declarative build file for its folder

A manifest is a declarative build file: Modbench makes its folder exactly what it says, and nothing else. It pins each package the folder is made from, and names where in which package each file comes from, so one manifest builds one folder on any machine. Modbench enforces no layout beyond this.

## Consequences

- A manifest owns its whole folder. Restore writes every file whose bytes differ, from its packages or by building the source, writes a mod's metadata, and sends every other file to the trash. So no two manifests build one folder, and no manifest builds a folder inside another's.
- A manifest builds only a folder inside the instance folder, because a build that owns its folder can destroy what the user keeps there.
- An installation file is pinned by its size and hash. The game folder is pinned by a hash of the files taken from it, never of the whole folder, because it holds files the folder does not take, and they change while the folder does not.
- A source mod's repository is pinned as a git submodule of the instance repository, because git already pins one repository inside another ([principles](../principles.md): Existing tools). Git holds its remote, the commit the modlist builds and the branch an update follows, so a commit in a source mod, its manifest included, changes one line in the instance repository. Restore clones an absent submodule, and never moves one that is at another commit.
- A source mod with no remote is no submodule. Its package has no host, so a clone cannot fetch it, and the manifest says so.
- Each file's line names its package and where in it the file is, so a FOMOD's choices restore as they were made. Each package is named once, so an upgrade changes one line.
- Update manifest records the folder into its manifest: the packages, any downloaded file that yields one of the folder's files included, and every file's line. The user writes the steps, the tools and the target line, and update manifest keeps them. Nothing else maintains a manifest.
- A manifest lives in the folder it builds, unless its target line names another. A manifest in its folder follows the folder through rename and uninstall, and git tracks it in place of the files it cannot hold ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). A source mod's manifest lives in its repository, names its mod folder, and pins the installation files its build reads, never other installed mods. A modlist is its manifests, a source mod's in its submodule, with the profiles beside them.
- A folder that differs from its manifest is a stale or hand-edited build output. Restore rebuilds it, and update manifest records it in its manifest, which git then shows as a change.
- A file in a folder that is not a source mod, which no package yields with its bytes, is one a clone cannot rebuild, and the manifest says so. The user ships such a change in a source mod with a remote: as a patch, as modding practice ships one, or as steps that make it from the package.
- A folder with no manifest is left alone, because it can be a mod the user has not recorded yet.

## Alternatives rejected

- Wabbajack's one record for the whole list. One artifact nobody diffs or merges, and a mod's history is lost inside it.
- A package on every file's line, as Wabbajack records it. Every line repeats its package, so an upgrade rewrites every line instead of one.
- One package per folder, as installing makes a mod. A folder merged from two downloads then cannot restore, so one package per folder is advice, not a rule.
- A manifest maintained by every gesture that writes a mod's files. Always on, with a watcher reconciling each external change; a gesture the user runs is the modlist's one door.
- Every source mod recorded as any other mod is, so the modlist never touches source. The files its source provides are then files no package yields.
- A source mod's manifest in the modlist beside the others. It repeats what the source mod's repository and its submodule already pin.
- The manifest pins a source mod by its remote and commit. Each commit then rewrites every line the source provides, and Modbench maintains what git's submodules already do.
- The manifest pins a source mod by a branch. A branch moves, so two clones of one commit build two different mods.
- Git hooks that write the manifests before a commit and restore the folders after a checkout, so git's gestures are the only ones. A failed post-checkout hook does not fail the checkout, so the folders are left half restored with nothing shown, and a pre-commit hook commits manifests the user never reviewed.
- A declaration of what the modlist needs from outside itself, such as the game build and the mod manager's plugins, which Modbench checks and never installs. A manifest already builds any such folder inside the instance that a modlist wants built, and a second mechanism names the same packages again.
- A source control provider that shows a folder that differs as an uncommitted change. The manifest is the folder's source, so the folder is its output, not a working tree.
