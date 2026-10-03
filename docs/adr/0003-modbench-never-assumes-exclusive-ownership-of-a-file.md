# Modbench never assumes exclusive ownership of a file

Any tool or the user can change any file Modbench reads, at any moment ([principles](../principles.md), *Modbench owns nothing*). So every state Modbench derives from a file validates by the file's content, never by trust in its own last write or in the watcher. A tracked plugin's binary is the one file git cannot show, so when its bytes differ from what Modbench last wrote, Modbench tells the user and does nothing else.

## Consequences

- **A rollback never reverts a third party's write.** It restores only what the action still owns ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).

## Alternatives rejected

- **Assume ownership: lock the files, or trust the last write.** The principle rules it out.
- **Detect by modification time alone.** Other tools' writes can preserve it.
- **Detect from the watcher's event list.** Events are lossy and Modbench's own writes are in them. The bytes on disk are the only oracle that cannot drift.
- **Refuse every write to the mod until the user answers a question.** Modbench's part ends at the notice. A gate on every write stands between the user and the work ([principles](../principles.md), *Minimal by default*).
- **Offer answers on the notice: commit to `main` as a new baseline, or apply to the working tree.** Each answer chains several steps that the user does with git.
- **Watch every tracked file, not only the plugin.** Git already shows every tracked file except the binary.
- **Git tracks the binary, with a diff driver that shows its records.** The plugin source is the one truth git versions ([ADR-0006](0006-decompilation-is-provably-faithful.md)).
- **Decompile an external change into the working tree at once.** Modbench would write the user's working tree unasked.
