# A mod is restored from its manifest

Each mod has one manifest file, and the mod is restored from it: the manifest says how the mod folder is made, naming what it is made from, the steps that build it, and where each of the mod's files comes from. The user writes the steps; update manifest, or a source mod's build, writes the rest from the mod as it is, and nothing else maintains a manifest. A manifest lives where the mod's source of truth does: in a source mod's repository, else in the mod folder.

## Consequences

- A file in a mod that is not a source mod, which the mod's package does not yield with its bytes, is one a clone cannot rebuild, and the manifest says so. The user ships such a change in a source mod with a remote: as a patch, as modding practice ships one, or as steps that make it from the package.
- Any other mod's manifest lives in its folder, so it follows the mod through rename and uninstall, and git tracks it in place of the files it cannot hold ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). A modlist is the manifests of its mods, a source mod's in its submodule, with the profiles beside them.
- Restoring makes a mod folder what its manifest says: it writes every file whose bytes differ, from the downloaded files or by building the source, writes the mod's metadata, and sends every other file the manifest does not name to the trash. A mod folder with no manifest is left alone, because it can be a mod the user has not recorded yet.

## Alternatives rejected

- Wabbajack's one record for the whole list. One artifact nobody diffs or merges, and a mod's history is lost inside it.
- A manifest maintained by every gesture that writes a mod's files. Always on, with a watcher reconciling each external change; a gesture the user runs is the modlist's one door.
- Every source mod recorded as any other mod is, so the modlist never touches source. The files its source provides are then files its package does not yield.
- A source mod's manifest in the modlist beside the others. It repeats what the source mod's repository and its submodule already pin.
- Git hooks that write the manifests before a commit and restore the folders after a checkout, so git's gestures are the only ones. A failed post-checkout hook does not fail the checkout, so the folders are left half restored with nothing shown, and a pre-commit hook commits manifests the user never reviewed.
