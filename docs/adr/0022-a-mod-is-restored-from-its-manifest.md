# A mod is restored from its manifest

Each mod has one manifest file, and the mod is restored from it: the manifest names where each of the mod's files comes from. A gesture writes the manifests from the mods as they are, and nothing else maintains them.

## Consequences

- A file the user changed comes from nowhere a download provides, so the gesture writes a delta from the download's copy, keyed by the file and the hashes of both ends, as a build output. Publishing it is the user's, and restore finds it by its key wherever they put it. A file with no base, or whose delta is too large a share of it, has no source until the user packages it as a downloaded file, and the manifest says so.
- The manifest lives in the mod folder, so it follows the mod through rename and uninstall, and git tracks it in place of the files it cannot hold ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). A modlist is the manifests of its mods, with the profiles beside them.
- Restore writes the mod's files from the manifest and the downloads, replacing the mod folder, which no other gesture does to a mod the user did not uninstall.
- A tracked mod's plugin is a file like any other here. The manifest knows nothing of plugin source, and compile for a plugin and restore for a mod can disagree, which ADR-0003's notice shows.

## Alternatives rejected

- Wabbajack's one record for the whole list. One artifact nobody diffs or merges, and a mod's history is lost inside it.
- A manifest maintained by every gesture that writes a mod's files. Always on, with a watcher reconciling each external change; a gesture the user runs is the modlist's one door.
- Deltas inlined in the record, as Wabbajack does. Git cannot hold them.
