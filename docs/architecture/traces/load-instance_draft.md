# load-instance: contract (draft)

Diagram: [load-instance.d2](load-instance.d2). Catalog row: `refresh` under
Instance in [commands.md](../commands.md). Governed by
[ADR-0003](../../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md),
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

Each story cites its source. Loading the instance has no gesture of its own. `refresh` is the one
gesture that runs it, so the shared block is what every load promises.

## Shared: loading the instance

As a user, I want:

1. Every view to show the same thing, whichever tool or gesture changed a file. *diagram header;
   ADR-0015, invariant 2*
2. A burst of changes to cause one load. *ADR-0015, invariant 7*
3. The value replaced whole, so two views never show two generations. *ADR-0015, invariant 6*
4. A file that cannot be parsed to leave the last good value in place. *ADR-0015, invariant 7*
5. A torn write to be read again after it settles, and shown only if the second read agrees.
   *ADR-0015, invariant 7*
6. A change to reach mEdit as a new load order. *diagram; ADR-0013*

## refresh

As a user, I want:

1. One refresh for all of Modbench. *catalog Meaning; One identity*
2. It to drop and rebuild the index, and to read every source from disk again. *catalog Meaning*
3. It to be a safety net, never how changes normally arrive. *catalog Meaning; ADR-0015*
4. Refresh refused while another window holds the index, with the reason. *catalog Meaning; ADR-0009,
   invariant 5*
5. A failed refresh to leave the views as they were, and to say why. *A failed gesture writes nothing;
   ADR-0019*

## Test seam

- **The Toolbox:** that `refresh` is offered, and what it reports.
- **The Instance loader:** given watch events and the bytes of the MO2 files, the value and its sequence, and
  the load order snapshot.

## Open Questions

1. **Debounce.** The diagram says "debounced". The old spec gives 200 ms for Downloads. Is the interval
   a rule?
2. **What the user sees on a parse failure.** ADR-0015 keeps the last value. The old spec shows an error
   node in Mods and reports once. Accept?
3. **No instance.** The old spec shows a welcome text when `ModOrganizer.ini`, `mods/` or `profiles/`
   is missing. Where should that live? It is a surface state.
