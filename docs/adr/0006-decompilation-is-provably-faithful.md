# Decompilation is provably faithful

Software compiles source into a binary. Modding runs the other way: the plugin is what the game
loads and what every other tool reads and writes, so an untracked plugin is the truth. Track
decompiles it into a source that Modbench edits in a git working tree and recompiles, and from
then on the source is the truth ([ADR-0007](0007-plugin-edits-are-git-working-tree-changes.md)).
That hand-over only works if the decompilation is provably faithful.

## Strategic invariants

1. **One plugin, at the mod folder root, and no second Modbench-owned copy.** The plugin is not
   committed to the mod's repository.
2. **The round-trip verdict is semantic: model identity, not byte identity.** Plugins come from
   many tools, and none of them can be trusted to be exactly right: the header's next FormID is
   almost always wrong, and a plugin often declares masters its content no longer needs. Modbench
   recompiles what the plugin means, so the header is recomputed and unneeded masters are dropped
   ([ADR-0008](0008-masters-are-derived-from-content.md)), and the rest of the byte differences
   are Mutagen's encoding choices. Byte identity would test whichever tool last wrote the file.
   The verdict is that every record has a model-identical counterpart after recompile, decided
   through one door that Track's gate and the tests share. The codec is the oracle, because Mutagen's generated equality lies by
   omission. A content difference is refused even when Mutagen's own writer caused it. Byte
   identity stays the test for our own codec on Mutagen-written fixtures.
3. **Semantically lossless, and nothing is re-sorted in the files, ever.** A diff shows what
   changed in the binary, header counters and shuffled lists included. That is true, not noise,
   and hiding it is the diff view's job at render time.
4. **A container's children live inline in the container's document, and no list carries
   order.** A child has no file; an edit, insert, delete or reorder of one is a hunk in one file.
   A group's records are files named by identity alone, so an insert or delete is one file and no
   sibling is ever renamed for another's arrival. The order the binary had is encoding, per
   invariant 2.
5. **Format identity is not stamped; compile failure is the uniform signal.** A format break, a
   hand edit and external corruption produce the same named compile failure and the same remedy,
   re-Track.
6. **Hand edits to the tree are ordinary edits.** Deleting a child file deletes a record; adding
   one adds a record. A document the codec cannot reproduce fails compile naming the path, and
   Modbench never repairs a tree changed behind its back.
7. **A plugin Mutagen cannot parse is diagnosed, never silently repaired.** Legitimate data that
   Mutagen's own model mishandles is refused as blocked upstream, because a byte-level fix of
   correct data is data destruction. A plugin malformed by another tool is repaired only by an
   explicit, previewed gesture the user confirms, never by Track, compile or load; the engine is
   specified in [medit-repair.md](../specs/medit-repair.md).

## Alternatives rejected

- **Spriggit's format as the truth.** Lossy on purpose, so it cannot be tested for losing by
  accident; not a library; pins Mutagen versions we cannot use. It has no role, not even as an
  import format; interop is export through the real tool.
- **The index as the truth.** A cache rebuilt from the plugins in seconds; making it
  authoritative inverts the dependency.
- **Binary as truth, text as a regenerated read-only view.** Discards git-native merge of
  content; a verified lossless text is trustworthy input, which gets the safety without the loss.
- **A committed binary plus a compile-on-commit hook.** A second copy confuses which is real, and
  the hook reverses the ungated commit.
- **Numbered filenames or order keys for child lists.** Each denormalizes an order the plugin
  does not have, and a mid-list insert rewrites siblings.
