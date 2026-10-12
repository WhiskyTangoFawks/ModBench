# A mod is restored from its manifest

Each mod has one manifest file, and the mod is restored from it: the manifest names where each of the mod's files comes from. For an untracked mod a gesture writes it from the mod as it is; for a tracked mod the build writes it, because the mod folder is the build's output. Nothing else maintains it.

## Consequences

- A file of an untracked mod that the user changed comes from nowhere a download provides, so the gesture writes a delta from the download's copy, keyed by the file and the hashes of both ends, as a build output. Publishing it is the user's, and restore finds it by its key wherever they put it. A file with no base, or whose delta is too large a share of it, has no source until the user packages it as a downloaded file, and the manifest says so.
- The manifest lives in the mod folder, so it follows the mod through rename and uninstall, and git tracks it in place of the files it cannot hold ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). A modlist is the manifests of its mods, with the profiles beside them.
- Restore writes the mod's files from the manifest and the downloads, replacing the mod folder, which no other gesture does to a mod the user did not uninstall.
- A tracked mod whose source has a remote is restored by building it: its manifest names the remote and a commit for every file the source provides, and restore clones the source when it is absent and builds it at that commit. Restore never moves a repository that is at another commit; it names the mod and the commit instead. A tracked mod with no remote, a vendored mod, is recorded as an untracked mod is, with deltas, because its source cannot be shared, and its build output and its source are then two truths that ADR-0003's notice reconciles.

## Alternatives rejected

- Wabbajack's one record for the whole list. One artifact nobody diffs or merges, and a mod's history is lost inside it.
- A manifest maintained by every gesture that writes a mod's files. Always on, with a watcher reconciling each external change; a gesture the user runs is the modlist's one door.
- Deltas inlined in the record, as Wabbajack does. Git cannot hold them.
- Every tracked mod recorded as deltas, so the modlist never touches source. An authored mod with a remote then carries two truths for each of its files when one would do.
