# index-load-order: contract

Diagram: [index-load-order.d2](index-load-order.d2). Catalog row: the system command `put load
order` in [commands.md](../commands.md). What the views show while it runs is in
[plugins.md](../surfaces/plugins.md), States. Governed by
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0012](../../adr/0012-every-plugin-in-the-instance-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

A file changing and the active plugins changing are two events (ADR-0009, invariant 1). This flow
carries every change mEdit sees: a plugin file that appears, changes or disappears, a source
document that changes, and a change to the active plugins. Each snapshot is also the signal that a
file may have changed (ADR-0013, invariant 1).

## The flow

1. Instance commands send the whole snapshot to Commands, through the mEdit client and the HTTP
   endpoints: every plugin file in the instance, as origin, file name and path; the active
   plugins, as origin and file name, in load order; and the game release (ADR-0013, invariants 2
   and 3). The mEdit client sends one snapshot at a time, and a newer one replaces a snapshot
   still waiting.
2. Commands puts the snapshot in Load order state, and answers at once with its version. The index
   follows.
3. Load order state tells the Indexer that a snapshot arrived, and the Indexer reconciles.
4. The Indexer compares each half of the snapshot with the one it last reconciled, and validates
   every plugin it holds (ADR-0009, invariant 4). A file whose size, mtime and ctime held since its
   last hash is not read (ADR-0009, Derived tactical observations).
   - A plugin whose file left loses its rows.
   - A plugin that arrived is read only when the index holds no rows for its content, by hash.
   - A plugin whose bytes changed is read again.
   - A tracked plugin's source documents are compared the same way, and each one that changed is
     read again by key. When the repository's HEAD moved, the committed rows are compared too.
   - A plugin that became tracked or untracked is read again, from its new source.
   - Changed active plugins read and drop no row.
5. For each plugin it reads, one at a time, the Indexer reads the documents through the Source
   adapter when the mod tracks the plugin, and the bytes through the Plugin adapter when it does
   not. It takes the schema from the Codec, and writes the plugin's rows to the Store.
6. After the last plugin, when anything changed, the Indexer takes the active plugins from Load
   order state and computes each FormKey's winner once.
7. Through Ports, the Indexer publishes the index status at each plugin: reconciling, with the count
   done, then ready. Master issues and conflicts are part of the status only once step 6 is done.
   The Store publishes the rows that changed, with a sequence (ADR-0015, invariant 3). A snapshot
   that changes nothing publishes nothing.

## Hand-off

The views read again on the rows that changed, and not before. The index status drives each
view's progress and states (plugins.md, States).

## Refusals and failures

Nothing here refuses a gesture: no user starts this flow. Each outcome is the index status's.

| Outcome | What the status says | What stays |
|---|---|---|
| Another window holds the instance's index | held elsewhere, naming the index file and saying to close mEdit there | Nothing is read (ADR-0009, invariant 5). |
| A plugin cannot be read or parsed | ready, with the plugin flagged and its reason | The plugin stays in the index, never dropped (ADR-0013, invariant 4). It is read again only when its bytes change. |
| The reconcile fails | failed, with the reason | The snapshot stays held. Each plugin is read in its own transaction, so the plugins read before the failure stand. The next snapshot tries again. |
| mEdit stops before the reconcile ends | nothing | The next start's snapshot finds the plugins already read, by their hashes, and reads the rest. |

## Test seam

From the HTTP `put load order` to the published status and rows, as the diagram draws it.

- **In:** a snapshot, the snapshot before it, and the files and repositories it names.
- **Observed:** the Store's rows, which plugins' records a read answers, the sequence of index
  statuses, and the published keys and sequence.
