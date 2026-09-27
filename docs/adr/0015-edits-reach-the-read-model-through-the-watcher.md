# Edits reach the read model through the watcher

Modbench never assumes exclusive ownership of a file
([ADR-0003](0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)), so a watcher and
validation must exist for every file it reads. Once they exist, Modbench's own write can take the
same path as another tool's: a command writes a system of record and returns, and the change
comes back to the read model through the watcher. Both processes have that shape. In mEdit the
read model is the record index, over the plugin files and the source tree. In Modbench it is the
instance value, over the mod manager's files. One architecture on both sides of the HTTP boundary
is worth more than either side's local optimum.

## Strategic invariants

1. **Two systems of record, one read model, on each side.** The read model is a materialized view
   over the files, rebuilt from them, never a source of truth, and never read by the write side.
2. **A command writes a system of record and returns.** It pushes nothing into the read model;
   the watcher over the file it wrote is how the change comes back, so a change from Modbench and
   a change from another tool are one signal.
3. **Read-your-writes belongs to the read side.** When a projection lands, the read model
   publishes which rows changed and a sequence, and the front end re-reads then. The same
   notification carries hand edits and other tools' writes, which have no other channel.
4. **A watcher event is a signal, never the change.** No event names a file to either read model.
   Every recompute sends the snapshot, and the record index validates every file against it by
   content ([ADR-0009](0009-the-record-index-mirrors-the-files-on-disk.md), invariant 4). A lost
   event delays a change and never hides it: the next signal finds it. Validation is idempotent by
   hash, so a duplicate signal is harmless.
5. **The write side's inputs are the source text, the plugins and the schema.** It reads the
   plugins for where each plugin's file lives and the Source adapter for whether a mod is
   tracked. Parse status comes from the codec at edit time. A document is never taken from the
   read model, and a missing file is a refusal.
6. **The instance value is whole and immutable.** Replaced whole by each recompute, with no
   partial update and no per-key invalidation, so a consumer never holds two facts from two
   generations. Recompute is whole, not incremental, while a full walk stays affordable.
7. **The Instance loader owns the one watcher on the instance, and a bad read keeps the last
   value.** mEdit watches nothing. A watcher event, activation, refresh and the window regaining
   focus run the same whole recompute, debounced once. Each recompute that lands sends the snapshot
   to mEdit ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md), invariant 1). A read
   that throws keeps the last value, and publishes the reason beside it until a read lands.

## Alternatives rejected

- **Validate on read, or the write side pushes its result into the read model.** Read-your-writes
  without the watcher round trip, and faster. It gives a Modbench write a different path from
  another tool's, so the path that matters least is the one that gets tested.
- **A cache per view, invalidated per signal.** Every new fact needs its own invalidation rule,
  and the rules disagree at exactly the moments that matter.
- **A watcher per mod folder in mEdit.** On Linux each .NET watcher holds its own inotify
  instance, and a large modlist passes the per-user limit. Two watchers over one tree also see two
  sets of events.
- **Forward the changed paths to mEdit.** VS Code's watcher drops events on an overflow and tells
  no extension. On Linux it reports a renamed folder's later changes under the old path. A wrong or
  missing path leaves the index wrong in silence; a late signal only delays it.
- **Trust the watcher to see every change.** A watch that VS Code stops is never restarted. Focus
  is the one trigger no watcher can lose, and it comes when the user returns from another tool.
- **Incremental update keyed by the changed path.** Brings back per-key invalidation and the
  two-generations bug.
