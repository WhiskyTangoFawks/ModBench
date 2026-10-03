# Modbench never assumes exclusive ownership of a file

This decision applies the principle *Modbench owns nothing* ([principles](../principles.md)) to every file Modbench reads or writes, and to the state Modbench derives from them.

## Strategic invariants

1. **Disk-derived state validates by content, never by trust in its own last write.** The record index hashes every file it holds rows for ([ADR-0009](0009-the-record-index-mirrors-the-files-on-disk.md)). The Instance loader rebuilds the instance value whole from the mod manager's files ([ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md)). Modbench compares a tracked plugin's bytes with what it last wrote.
2. **The watch is never trusted alone.** Every watched state also validates by content, as [ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md) says.
3. **Modbench tells the user when a tracked plugin changes outside it, and the user owns what follows.** A tracked plugin exists twice: the binary, and its plugin source, which git versions. Git shows every change to the source and to every other tracked file. The binary is the one copy git cannot see. Each time the snapshot arrives, Modbench compares each tracked plugin's bytes with what it last wrote. A plugin whose bytes differ changed outside Modbench, and Modbench tells the user. Modbench keeps nothing about the change, and refuses nothing because of it.
4. **A third party's concurrent write is preserved and named, never reverted.** A rollback restores only what the action still owns ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).

## Derived tactical observations

- "What Modbench last wrote" is a parked ref: each compile records the compiled working tree as a commit object outside every branch, its message carrying the binary's hash, and Track initializes it to the pristine snapshot. No porcelain gesture can move it. A missing or orphaned ref counts as a change, and Modbench tells the user. Modbench never guesses.

## Alternatives rejected

- **Assume ownership: lock the files, or trust the last write.** The principle rules it out.
- **Detect by modification time alone.** Other tools' writes can preserve it.
- **Detect from the watcher's event list.** Events are lossy and Modbench's own writes are in them. The bytes on disk are the only oracle that cannot drift.
- **Refuse every write to the mod until the user answers a question**, the design this replaces. Modbench's part ends at the notice. A gate on every write stands between the user and the work ([principles](../principles.md), *Minimal by default*).
- **Offer answers on the notice: commit to `main` as a new baseline, or apply to the working tree.** Each answer chains several steps that the user does with git.
- **Watch every tracked file, not only the plugin.** Git already shows every tracked file except the binary.
- **Git tracks the binary, with a diff driver that shows its records.** The plugin source is the one truth git versions ([ADR-0006](0006-decompilation-is-provably-faithful.md)).
- **Decompile an external change into the working tree at once.** Modbench would write the user's working tree unasked.
