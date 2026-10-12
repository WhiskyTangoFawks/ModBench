# A mod is restored from its manifest

Each mod has one manifest file, and the mod is restored from it: the manifest names where each of the mod's files comes from. For a source mod the build writes it, because the mod folder is the build's output; for any other mod, stage writes it from the mod as it is. Nothing else maintains it.

## Consequences

- A file the user changed, in a mod that is not a source mod, comes from nowhere a downloaded file provides, so stage writes a delta from the downloaded file's copy, keyed by the file and the hashes of both ends, as a build output. Publishing it is the user's, and restore finds it by its key wherever they put it. A file with no base, or whose delta is too large a share of it, has no provider until the user packages it as a downloaded file, and the manifest says so.
- The manifest lives in the mod folder, so it follows the mod through rename and uninstall, and git tracks it in place of the files it cannot hold ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)). A modlist is the manifests of its mods, with the profiles beside them.
- Discard changes writes every file a manifest names whose bytes differ, from the downloaded files or by building the source, and leaves untracked files alone, as git does. Only `clean` removes, after listing what it will remove.
- A source mod whose repository has a remote is restored by building it: its manifest names the remote and a commit for every file the source provides, and the rebuild clones the source when it is absent and builds it at that commit. It never moves a repository that is at another commit; it names the mod and the commit instead. A source mod with no remote, a vendored mod, is recorded as any other mod is, with deltas, because its source cannot be shared, and its build output and its source are then two truths that ADR-0003's notice reconciles.

## Alternatives rejected

- Wabbajack's one record for the whole list. One artifact nobody diffs or merges, and a mod's history is lost inside it.
- A manifest maintained by every gesture that writes a mod's files. Always on, with a watcher reconciling each external change; a gesture the user runs is the modlist's one door.
- Deltas inlined in the record, as Wabbajack does. Git cannot hold them.
- Every source mod recorded as deltas, so the modlist never touches source. An authored mod with a remote then carries two truths for each of its files when one would do.
