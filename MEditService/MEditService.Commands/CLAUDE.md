# MEditService.Commands

Commands. The write side: one handler per gesture, each answering applied or a typed refusal. It
owns resolving a target under the load order, the external-change check and rename. It writes
through the Source and Plugin adapters and never reads or writes the record index, which learns of a
write when the Mod watcher sees the file change (ADR-0015).

- Draw a new FormKey only through `WriteTargets.ResolveTargetFormKey`. It unions the working tree
  with HEAD, so an ID a working-tree delete freed is not reused before compile; a gesture drawing
  several keys from one allocator passes the ones it drew as `taken`.
