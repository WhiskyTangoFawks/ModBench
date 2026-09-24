# edit-record: contract (draft)

Diagram: [edit-record.d2](edit-record.d2). Catalog rows under Record: `edit field`, `add element`,
`remove element`, `move element`, `create`, `delete` and `copy`, in
[commands.md](../commands.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0006](../../adr/0006-decompilation-is-provably-faithful.md),
[ADR-0007](../../adr/0007-plugin-edits-are-git-working-tree-changes.md),
[ADR-0008](../../adr/0008-masters-are-derived-from-content.md),
[ADR-0012](../../adr/0012-every-plugin-copy-is-indexed.md),
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md) and
[ADR-0018](../../adr/0018-xedit-is-the-reference-for-record-editing.md).

Each story cites its source. The stories under Shared apply to every gesture in this file.

`renumber` is not here. Its design is the ticket "Design: cross-plugin dependency
coordination doctrine (renumber, underride, rename, compaction)".

## Shared

As a user, I want:

1. To edit only a plugin that is tracked. An untracked plugin is read-only, and the refusal names
   Track. *ADR-0007, invariant 1*
2. An edit to change plugin source in the working tree, and never the binary. *ADR-0007, invariant 4*
3. An edit to need no deploy and no compile. *ADR-0007, invariant 4; ADR-0002*
4. A structural edit to show as one change in one file. *ADR-0006, invariant 4*
5. An edit to a losing copy of a plugin refused. *ADR-0012, invariant 5*
6. An edit refused while an external change to that mod is unanswered. *ADR-0003, invariant 3*
7. A refused or failed edit to leave the working tree as it was, and to say why, naming the field.
   *A failed gesture writes nothing; Refuse, do not repair; ADR-0019*
8. The panel to show the change when the watch reads it back, and not before. *ADR-0015, invariants 2
   and 3; diagram*
9. Review and commit to be git's own. *ADR-0007, invariants 4 and 5*

## edit field, add element, remove element, move element

As a user, I want:

1. A field's value set. *catalog Meaning*
2. An element added to an array, removed, or moved one step in an unsorted array. *catalog Meaning*
3. No move on a sorted array. *catalog Meaning*
4. The header's masters to stay read-only. *ADR-0008, invariant 2*
5. Values to read and edit as xEdit does. *ADR-0018*

## create

As a user, I want:

1. A new record added to a plugin, with a record type I choose. *catalog Options*

## delete

As a user, I want:

1. The chosen records removed from the plugin. *catalog Meaning*
2. To be asked first, with everything selected listed once. *Confirm what destroys; catalog Meaning*
3. Esc to remove nothing. *Esc changes nothing*
4. A deleted record's source file removed as a working-tree change I can review. *ADR-0007,
   invariant 5*

## copy

As a user, I want:

1. Records copied into other plugins, with a mode and a destination I choose. *catalog Options*
2. A destination that already holds a copy to ask whether to replace it. *catalog Meaning; Confirm
   what destroys*
3. Esc on either pick to copy nothing. *Esc changes nothing*

## Test seam

- **The driving box:** what is offered, the pickers, the prompts, the confirmations, and Esc.
- **The Core box:** given its Argument and Options, what it writes, or the refusal.

The panel re-reading is tested in [index-load-order_draft.md](index-load-order_draft.md).

## Open Questions

1. **The refusals.** The old spec lists what an edit refuses: an element that is not there, a move off
   either end, a value the codec rejects, an unparseable FormKey, a duplicate key, a missing
   discriminator, a read-only member. Each is a refusal under Refuse, do not repair. An edit that sets
   the value it already has does nothing, under Doing nothing is not an error. Accept the list as the
   test cases?
2. **Untracked refusal wording.** The old spec names Track, and for a plugin with no mod folder says
   "author a patch plugin". Accept?
3. **The next free FormID.** The old spec gives a new record the next free FormID, safe against both
   refs. No source in the catalog. Accept?
4. **Copy destinations.** The old spec lists only mutable plugins, and for an override copy leaves out
   any plugin that already holds the record. Accept?
5. **Copy to `new`.** The old spec keeps the source EditorID and takes the next free FormID. The
   catalog notes a contradiction between two tickets about prompting for an EditorID.
