# Modbench never assumes exclusive ownership of a file

This decision applies the principle *Modbench owns nothing* ([principles](../principles.md)) to
every file Modbench reads or writes, and to the state Modbench derives from them.

## Strategic invariants

1. **Disk-derived state validates by content, never by clock and never by trust in its own last
   write.** The record index hashes every file it holds rows for
   ([ADR-0009](0009-the-record-index-mirrors-the-files-on-disk.md)); the instance value is rebuilt
   whole from MO2's files
   ([ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md));
   a tracked plugin's bytes are compared against what Modbench last wrote.
2. **Watchers are never trusted alone.** Every watched state also validates at load and on
   reconcile, and a watcher overflow triggers validation
   ([ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md)
   invariant 4).
3. **A tracked mod's external change is one question per mod.** A mod has changed externally
   when a tracked plugin's bytes differ from what Modbench last wrote, or a file git tracks outside
   `source/` differs from git's view of the edit branch. One classification runs per mod, against
   git and never against the event list, at settle and at the load-time check. While the question
   is open every write to every plugin the mod holds is refused, because a compile would overwrite
   the evidence. The classifier is the authority; a marker only caches its verdict and is dropped
   on a verdict of nothing, so bytes restored by hand end the question without an answer. One
   dialog asks, and either answer covers the whole mod: upstream update, a new baseline on `main`,
   or your own edit, working-tree dirt. The edit branch moves only when the user rebases it.
   The default answer is always the new baseline on `main`, and `meta.ini` takes no part in the
   question.
4. **A third party's concurrent write is preserved and named, never reverted.** A rollback
   restores only what the action still owns
   ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).

## Derived tactical observations

- "What Modbench last wrote" is a parked ref: each compile records the compiled working tree as a
  commit object outside every branch, its message carrying the binary's hash, and Track
  initializes it to the pristine snapshot. No porcelain gesture can move it, and a missing or
  orphaned ref degrades to asking the user, never to guessing.

## Alternatives rejected

- **Assume ownership: lock the files, or trust the last write.** The principle rules it out.
- **Detect by modification time.** Other tools' writes can preserve it.
- **Classify from the watcher's event list.** Events are lossy and Modbench's own writes are in
  them; git's view of the tree is the only oracle that cannot drift.
- **Answer external change per plugin.** A mod with two plugins would be two questions about one
  upgrade, and a compile of the second would overwrite the evidence for the first.
