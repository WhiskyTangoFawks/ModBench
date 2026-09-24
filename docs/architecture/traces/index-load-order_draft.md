# index-load-order: contract (draft)

Diagram: [index-load-order.d2](index-load-order.d2). Catalog row: the system command `put load order` in
[commands.md](../commands.md). Governed by
[ADR-0009](../../adr/0009-the-record-index-mirrors-the-files-on-disk.md),
[ADR-0012](../../adr/0012-every-plugin-copy-is-indexed.md),
[ADR-0013](../../adr/0013-mod-management-hands-editing-the-load-order.md) and
[ADR-0015](../../adr/0015-edits-reach-the-read-model-through-the-watcher.md).

Each story cites its source. The trigger is a change to the load order. No user starts it, so
this file has no driving-box seam.

## put load order

As a user, I want:

1. mEdit to receive the whole load order every time it changes. *catalog Meaning; ADR-0013,
   invariant 1*
2. A load order that has not changed to do nothing. *ADR-0013, invariant 1; Doing nothing is not an
   error*
3. Every copy of a plugin indexed, not only the winner. *ADR-0012*
4. A plugin that is new to the load order indexed, and one that is gone removed. A plugin that only
   moved keeps its rows. *ADR-0013, invariant 1; ADR-0009, invariant 1*
5. A plugin whose file changed re-indexed. *ADR-0009, invariant 4*
6. A plugin that fails to parse listed and flagged, never dropped. *ADR-0005, invariant 5; ADR-0012*
7. Only enabled, listed, winning copies to compete for a record. *ADR-0013, invariant 3*
8. The views to re-read when the rows change, and not before. *ADR-0015, invariant 3; diagram*
9. A second window on the same instance to be refused by name. *ADR-0009, invariant 5*

## Test seam

The commands, from the HTTP `put load order` to the Store's published change, as the diagram draws it.

- **In:** a load order snapshot, and the files it names.
- **Observed:** the Store's rows, and the published keys and sequence.

## Open Questions

1. **A failed put.** The old spec says nothing is torn down, the error is shown, and the next snapshot
   retries. Which principle says so? ADR-0019 covers the error only.
2. **Progress.** The old spec shows one progress indicator in the Plugins view header while plugins
   index, and withholds master issues until loading ends. Accept?
3. **A closed mEdit mid-load.** The old spec calls it abandonment, not a failure. Accept?
4. **The status bar.** The old spec has five status-bar texts for the backend. That is a surface
   document, not this contract.
