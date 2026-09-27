# Mod Management hands Editing the load order

Modbench's data is two layers. The file layer is the mods and their files, resolved by mod order.
The record layer is the plugins and their records, resolved by plugin order. A plugin file is where
the two meet. Mod Management owns the file layer: both orders and every file of the mod manager,
read through the Instance adapter. Editing owns the record layer and reads none of the mod
manager's files. Mod Management hands Editing one snapshot: every plugin in the instance, and the
active plugins, in load order ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md)). It
sends the snapshot whenever anything that feeds it changes, and a fact about a mod that Editing
needs arrives as data too. Modbench is one tool
([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)), so Editing reconciles the snapshot
it is handed and never reloads.

## Strategic invariants

1. **The snapshot arrives whole, as state, and is reconciled.** Mod Management builds it from one
   instance value ([ADR-0015](0015-edits-reach-the-read-model-through-the-watcher.md), invariant 6),
   so its two halves never come from two reads. It sends the snapshot at every recompute of that
   value, changed or not: the snapshot is also the signal that a file may have changed. Editing
   compares each half with the one it holds. Changed plugins index only what the record index has
   never seen. They drop the rows of each plugin whose file left. Changed active plugins run one
   winner sweep, and read or drop no row. Every snapshot, identical or not, validates every file
   ([ADR-0009](0009-the-record-index-mirrors-the-files-on-disk.md), invariant 4).
2. **The snapshot names every plugin in the instance
   ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md)), each as origin, filename and
   path.** It names the files on disk, never deploy's links. Mod order, `plugins.txt` and enabled
   state decide none of them.
3. **Mod Management alone decides the active plugins, and sends them in load order.** Mod
   Management reads the plugins the game loads with no line itself. It takes the game's masters
   from a per-release table, and its Creation Club plugins from the game folder. Editing derives
   nothing. A plugin is active exactly when the snapshot lists it as active. Its place in that
   list is its load index. No SQL re-spells it.
4. **The snapshot is a value in Editing's shared kernel. Only put load order writes it, and both
   sides and the adapters read it.** There is no session: nothing is loaded, reloaded or exited,
   and a plugin that fails to parse is a row in an error state, the way a file with a diagnostic
   is still a file.

## Derived tactical observations

- Opening the record index keeps the last active plugins it held. The snapshot sent on activation
  corrects them.

## Alternatives rejected

- **A bulk load verb plus a verb per loadout gesture:** reread for a
  mod-order change, participation for enable and disable, load and unload for unlisted plugins.
  Every future gesture would need its own endpoint and its own drift story.
- **Each plugin with its slot, enabled and winning facts, and Editing derives which plugins are
  active**. One list carried two events, so Editing diffed it to learn
  which had happened. It kept a registered state between indexed and active. It re-derived a rule
  over Mod Management's own files.
- **Editing reads the plugins the game loads with no line, through Mutagen.** Deciding the active plugins then
  spans both sides, and Mod Management waits on Editing before it can send. The game's masters
  are a short per-release list.
- **Editing reads `modlist.txt` and `plugins.txt` itself.** Self-validating like the record
  index, but puts the mod manager's formats and mod order inside Editing, and `plugins.txt` alone
  cannot say which mod's file a name means.
