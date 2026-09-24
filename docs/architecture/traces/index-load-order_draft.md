# index-load-order: contract (draft)

Diagram: [index-load-order.d2](index-load-order.d2). Catalog row: the system command `put load
order` in [commands.md](../commands.md). What the views show while it runs is in
[plugins.md](../surfaces/plugins.md), States. Governed by
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0012](../../adr/0012-every-plugin-copy-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

A file changing and a load order changing are two events (ADR-0009, invariant 1). This flow is the
second: the registration changes, and rows are read only for content the index has never seen. The
first is the Mod watcher's, and it ends in the same tail.

## The flow

1. Instance commands send the whole load order snapshot to Commands, through the mEdit client and
   the HTTP endpoints: every physical copy, as origin, file name and path, with its slot, whether
   it is enabled and whether it wins, and the game release (ADR-0013, invariant 2). The mEdit
   client sends one snapshot at a time, and a newer one replaces a snapshot still waiting.
2. Commands puts the snapshot in Load order state, and answers at once with its version. The index
   follows.
3. Load order state tells the Mod watcher that the load order changed. The watcher arms one watch
   per mod folder the snapshot names, and asks the Indexer to reconcile.
4. The Indexer compares the snapshot with the one it last reconciled. An identical snapshot does
   nothing (ADR-0013, invariant 1). Otherwise:
   - A copy that left is unregistered. Its rows stay, and no read sees them.
   - A copy that moved, or whose enabled or winning fact changed, updates its registration only.
   - A copy that arrived is registered. The Indexer reads it only when the index holds no rows for
     its content, by hash (ADR-0009, invariant 4).
   - A copy that became tracked or untracked is read again, from its new source.
5. For each copy it reads, one at a time, the Indexer reads the documents through the Source
   adapter when the mod tracks the plugin, and the bytes through the Plugin adapter when it does
   not. It takes the schema from the Codec, and writes the copy's rows to the Store.
6. After the last copy, the Indexer takes the participating copies from Load order state, enabled,
   listed and winning (ADR-0013, invariant 3), and computes the winners and the conflicts once.
7. Through Ports, the Indexer publishes the index status at each copy: reconciling, with the count
   done, then ready. Master issues and conflicts are part of the status only once step 6 is done.
   The Store publishes the rows that changed, with a sequence (ADR-0015, invariant 3).

## Hand-off

The views read again on the rows that changed, and not before. The index status drives each
view's progress and states (plugins.md, States).

## Refusals and failures

Nothing here refuses a gesture: no user starts this flow. Each outcome is the index status's.

| Outcome | What the status says | What stays |
|---|---|---|
| Another window holds the instance's index | held elsewhere, naming the index file and saying to close mEdit there | Nothing is read (ADR-0009, invariant 5). |
| A copy cannot be read or parsed | ready, with the copy flagged and its reason | The copy stays registered, never dropped (ADR-0013, invariant 4). It is read again only when its bytes change. |
| The reconcile fails | failed, with the reason | The snapshot stays held. Each copy is read in its own transaction, so the copies read before the failure stand. The next snapshot tries again. |
| mEdit stops before the reconcile ends | nothing | The next start's snapshot finds the copies already read, by their hashes, and reads the rest. |

## Test seam

From the HTTP `put load order` to the published status and rows, as the diagram draws it.

- **In:** a snapshot, the snapshot before it, and the files and repositories it names.
- **Observed:** the registrations, the Store's rows, the sequence of index statuses, and the
  published keys and sequence.
