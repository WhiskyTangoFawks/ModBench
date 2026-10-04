# A tracked plugin's truth is its source

Software compiles source into a binary. Modding runs the other way: the plugin is what the game loads and what every other tool reads and writes, so an untracked plugin is its own truth. Track decompiles a plugin into a source that git versions, and from then on the source is the truth and compile derives the binary from it ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).

## Consequences

- Decompilation must be provably faithful. The source can take over only if it loses nothing. Faithful means model identity, not byte identity: plugins come from many tools, none writes them exactly right, and byte identity would test whichever tool last wrote the file.

## Alternatives rejected

- Spriggit's format as the truth. Lossy on purpose, so it cannot be tested for losing by accident; not a library; pins Mutagen versions we cannot use. It has no role, not even as an import format; interop is export through the real tool.
- The index as the truth. A cache rebuilt from the plugins in seconds; making it authoritative inverts the dependency.
- Binary as truth, text as a regenerated read-only view. Discards git-native merge of content; a verified lossless text is trustworthy input, which gets the safety without the loss.
- A committed binary plus a compile-on-commit hook. A second copy confuses which is real, and the hook reverses the ungated commit.
