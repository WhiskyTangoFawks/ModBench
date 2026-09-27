# Mod Management hands Editing the load order

Modbench's data is two layers. The file layer is the mods and their files, resolved by mod order.
The record layer is the plugins and their records, resolved by plugin order. A plugin file is where
the two meet. Mod Management owns the file layer: both orders and every file of the mod manager,
read through the Instance adapter. Editing owns the record layer and reads none of the mod
manager's files. Mod Management hands Editing the load order, as a value, whenever anything that
feeds it changes, and a fact about a mod that Editing needs arrives as data too. Modbench is one
tool ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)), so Editing reconciles the value
it is handed and never reloads.

## Strategic invariants

1. **The load order arrives whole, as state, and is reconciled.** Mod Management sends one
   idempotent snapshot on activation, a profile switch, a `modlist.txt` or `plugins.txt` write,
   an install or an uninstall. Editing registers what is new, indexing only what the record index
   has never seen, unregisters what is gone, updates slot and flags on what moved, then runs one
   winner sweep. A snapshot identical to the current state is a no-op.
2. **The snapshot names every plugin file in the instance**
   ([ADR-0012](0012-every-plugin-in-the-instance-is-indexed.md)), each with the three facts Mod
   Management already computes: the name's `plugins.txt` slot or none, whether its line is enabled,
   and whether this plugin is the one mod order resolves the name to. The one fact the service
   derives itself is which plugins the game loads with no line: the game's own masters and its
   Creation Club plugins, read from the game folder.
3. **The load order value derives participation, once. A plugin participates when it is winning,
   and either listed and enabled or loaded by the game with no line.** Participation
   is never a stored column and no SQL re-spells it. Only participating rows compete for winner
   or count in a conflict; a non-participating row is hidden by default and shown on request
   with the reason.
4. **The load order is a value in Editing's shared kernel. Only put load order writes it, and both
   sides and the adapters read it.** There is no session: nothing is loaded, reloaded or exited, and
   a plugin that fails to parse is a row in an error state, the way a file with a diagnostic is
   still a file.

## Derived tactical observations

- The snapshot is every plugin file on disk: every root-level plugin in every mod, enabled or not,
  in `overwrite/`, and the game's own plugins in the game folder, never deploy's links. The load
  order is a filter over it, so enabling a mod re-reads nothing.
- Opening the record index does not clear the registration rows; they are the last known load
  order, and the snapshot sent on activation corrects them.

## Alternatives rejected

- **A bulk load verb plus a verb per loadout gesture:** reread for a
  mod-order change, participation for enable and disable, load and unload for unlisted plugins.
  Every future gesture would need its own endpoint and its own drift story.
- **Editing reads `modlist.txt` and `plugins.txt` itself.** Self-validating like the record
  index, but puts the mod manager's formats and mod order inside Editing.
