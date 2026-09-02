---
status: accepted
---

# A failed renumber restores the working trees: failure atomicity, conditionally, without git

Governs the renumber cascade in `MEditService.Core/Edits/RecordEditService.cs` and the mechanism it
constructs, `MEditService.Core/Source/SourceWriteTransaction.cs`. Extends
[ADR-0041](0041-manual-git-tracking-compile-from-text.md) (one write path; refusals precede writes;
commit, stash and discard are the author's gestures) and
[ADR-0026](0026-error-surfacing-policy.md) (a partial outcome is a structured collection).

## Context

Renumbering a record moves its FormKey, and every FormLink pointing at it has to move with it or go
dangling. That cascade writes across **every source tree holding a reference** — other tracked mods,
other repositories, folders the author never chose to touch for this gesture.

#676 made the cascade compute before it writes: the whole write set — every affected record's new
bytes — is produced in memory first, and every way the computation can fail is a typed refusal
returned before the first byte lands. What #676 deliberately left exposed was genuine I/O. A write
that failed part-way left the writes before it durably on disk, and the error told the author so:

> Those repos now hold working-tree dirt from this partial renumber — review and revert in the
> Source Control panel as needed.

That is a real disclosure and it is honestly worded, but it hands the author a repair job across
repositories they did not choose, one Source Control view at a time, with no way to tell which
changes were theirs and which were ours. **That posture is overruled.**

It is worth naming what this is *not* a reaction to. A reader seeing intermediate state mid-write is
not a problem, and hiding in-flight state is not the objective. Transparency is fine. **Leaving
something broken behind after we are done is not.** This ADR is about failure atomicity only.

## Decision

1. **A renumber is all-or-nothing across every source tree it writes.** Phase two runs through a
   `SourceWriteTransaction`: the pre-image of each file the cascade is about to write is captured,
   held for the duration of the call, and on failure the acts are undone in reverse order. The
   overruled disclose-and-recover message is deleted, not deprecated (pre-alpha, zero users).

2. **The mechanism is small and explicit, constructed by the renumber path alone.** Not an ambient
   scope, not a chokepoint every write in the service passes through. `RenumberRecord` builds one and
   routes its own writes through it; `EditField`, `CreateRecord`, `DeleteRecord` and the compile path
   are untouched. A second caller wanting the same property will construct its own — that is a
   deliberate cost, paid to keep the write paths independent and the mechanism legible.

3. **It uses no git.** Nothing is written into the author's repository, no ref is created, no command
   is run. The pre-images live in memory for the length of one call. ADR-0041's standing posture —
   commit, stash and discard are the author's gestures, and Modbench never makes them on their behalf
   — is untouched.

4. **The guarantee is conditional, and stated as such.**

   > A failed renumber restores the working tree byte-for-byte with respect to everything the action
   > changed, and nothing else. A concurrent third-party write is preserved and named, never
   > reverted.

   Before restoring a path, the transaction verifies the path still holds exactly what the action
   left there. If another tool or the author has written or deleted it since — the root `CLAUDE.md`
   never-assume-exclusive-ownership rule, which MO2, xEdit and the author's own editor all make real
   — that change is kept and named in the error instead. One rule, applied uniformly: *restore only
   what this action still owns.* A file the action created and a third party then deleted is named
   too, even though its absence is what the rollback wanted, because the rule is about ownership, not
   about the outcome happening to match.

5. **Process death is out of scope.** An in-memory transaction dies with its process. The compile
   round-trip gate and re-Track remain the recovery path for a tree left mid-write by a crash, as
   they already are for #675's minted directories and for `RenormalizeGroupOrder`'s own half-finished
   pass. Making failure atomicity survive process death would mean an on-disk journal in the author's
   folder — new state, new staleness, new recovery semantics — for a failure mode the existing gate
   already catches.

6. **The index is re-derived, not rolled back.** It is a cache over the source trees, and unwinding
   rows would be a second implementation of what a re-ingest already computes, free to drift from it.
   After the files go back, every affected plugin is re-derived from its restored tree through
   `ILoadOrderMirror.ReingestPluginFromSource` (#672). Note that #677 already makes the renumber's own
   index update a single transaction, so the only index rows a mid-cascade failure can leave behind
   are the referencers' — exactly what the re-ingest corrects.

7. **A rollback that cannot complete reports, it does not fail silently.** `Rollback()` returns a
   structured `UnrestoredPath` collection (ADR-0026) — never a formatted string — carrying the
   reason and, for a genuine restore failure, the underlying error. The pass never stops at the first
   failure: one unwritable path must not cost every other tree its restore. Paths reach the author
   relative to the mod folder, which is the form the Source Control panel lists and which carries the
   plugin's own folder inside it; absolute paths go to the log only. **That includes the underlying
   fault's own message**, which is where the absolute path actually leaks: a real filesystem error
   reads `Access to the path '/…/mods/Foo/source/Foo.esp/Races/[0] x.json' is denied`. The cause is
   still shown — it is the only thing that says *why* — with every affected mod folder's prefix cut
   off it, textually, because an exception message is prose and there is no typed path to reach for.

8. **Directory lifetime stays with #675.** `SourceUnitResolver.InMintedDirectory` already lists
   missing ancestors before creating them and removes exactly those, non-recursively, when the write
   fails — so a directory a third party has written into survives. The transaction routes its writes
   *through* that wrapper and holds no directory pre-images of its own; two mechanisms racing to
   remove the same level would be worse than either. The one directory shape the transaction does own
   is the relocation of a container's whole subtree, which it puts back.

   The seam has a known edge, stated here so it is a decision rather than an oversight: #675 removes a
   minted directory when *that* write throws, and cannot remove one minted by a write that succeeded
   and is only being undone because a later act failed. **No write on the renumber path mints
   anything** — every referencer write goes to a resolved unit's own directory, the flat target's new
   leaf goes into the group folder its old leaf was already in, and the container target's new leaf is
   put in place by a move rather than a create — so the gap is latent, not live. Closing it
   speculatively would mean the transaction growing exactly the directory bookkeeping this point says
   it must not have. A future caller whose writes do mint is what reopens this.

## Why this differs from the multi-plugin compile batch

`CompileJournal.RunBatch` takes the opposite posture on purpose, and it is not being changed here. A
multi-plugin compile writes a marker into each mod folder's `.git/` naming every plugin in the batch,
moves each one from unlanded to landed as its compile succeeds, and deletes the marker only when all
of them have. A plugin that refuses stops the batch there — and **the plugins that already compiled
stay compiled**, with the unlanded set left in the marker for recovery to read. Disclose, then
recover.

Three things make that right there and wrong here:

- **Independence.** Each plugin's binary is its own artifact. A compiled `A.esp` is complete and
  correct whether or not `B.esp` compiled afterwards. The renumber cascade's writes are one edit
  spread across files: a referencer whose FormLink was rewritten to an identity the target never took
  holds a **dangling link** — strictly worse than not having been written at all. There is no partial
  result worth keeping, so there is nothing to disclose except the failure.
- **Who asked for it.** The author asked for each plugin in the compile batch by name. The renumber's
  author asked to renumber one record; the other repositories the cascade writes are consequences of
  the reference graph, not choices. Handing back working-tree dirt in a folder nobody selected is a
  different bargain from handing back a binary they asked for.
- **What the recovery costs.** A half-done compile batch is recoverable by re-running it — the
  marker says exactly what is missing, and compiling again is idempotent. A half-done renumber has no
  such re-run: the target's identity has already moved for some references and not others, so
  repeating the gesture does not converge, and the only honest repair is the one this ADR performs.

The compile batch also survives process death, which this does not, and that is the same trade seen
from the other side: it pays for that with on-disk state in the author's repository, which the
renumber deliberately refuses to write.

## Consequences

- The renumber's failure message no longer names repositories to review. It says the trees are back
  as they were, and names only what it deliberately left standing.
- The conditional half of the guarantee is real and must stay tested against **actual** third-party
  writes — a mocked one proves nothing, because what is being claimed is a fact about the bytes on
  disk between the write and the restore.
- "Unchanged" is asserted with two oracles: a direct filesystem comparison (path set, content, and
  the directory list *including empty directories*) and the repository's own `git status`. They are
  not redundant — git tracks files, not directories, and reports clean over precisely the empty-record
  -directory debris #675 exists to prevent. Tests demonstrate that disagreement rather than assuming
  it.
- The restore mechanism is testable on its own with a synthetic write sequence, which is what makes
  reverse ordering and the ownership check provable rather than merely exercised.
