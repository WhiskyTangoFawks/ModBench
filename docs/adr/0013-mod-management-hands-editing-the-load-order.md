# Mod Management hands Editing the load order

Mod Management owns both override orders and reads MO2's files; Editing reads neither. What
crosses between them is the Plugin load order, as a value, whenever anything that feeds it
changes, and the notification stream coming back. Nothing else crosses. Modbench is one tool
([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)), so Editing reconciles the value
it is handed and never reloads.

## Strategic invariants

1. **The load order arrives whole, as state, and is reconciled.** Mod Management sends one
   idempotent snapshot on activation, a profile switch, a `modlist.txt` or `plugins.txt` write,
   an install or an uninstall. Editing registers what is new, indexing only what the record index
   has never seen, unregisters what is gone, updates slot and flags on what moved, then runs one
   winner sweep. A snapshot identical to the current state is a no-op.
2. **The snapshot names every physical copy** ([ADR-0012](0012-every-plugin-copy-is-indexed.md)),
   each with the three facts Mod Management already computes: the name's `plugins.txt` slot or
   none, whether its line is enabled, and whether this copy is the one the Mod override order
   resolves the name to. The one fact the service derives itself is the set of forced names, the
   game's implicit masters and the Creation Club catalogue, read from the game directory at the
   API.
3. **Participation is derived, once, in the load order value: enabled, winning and listed.** It
   is never a stored column and no SQL re-spells it. Only participating rows compete for winner
   or count in a conflict; a non-participating row is hidden by default and shown on request
   with the reason.
4. **The load order is a value in Editing's shared kernel, written by the API alone and read by
   both sides and the adapters.** There is no session: nothing is loaded, reloaded or exited, and
   a plugin that fails to parse is a row in an error state, the way a file with a diagnostic is
   still a file.
5. **No "mod" crosses.** Mod Management sends plugin files at physical paths plus the two
   booleans above, and no modlist, profile or mod name.

## Derived tactical observations

- The snapshot is what Mod Management already walks for its file order conflict index: every root-level
  plugin in every enabled mod, `overwrite/`, and the `Data/` copy of every listed name no mod
  provides. A disabled mod's plugins are not in it, so enabling a mod is when its copies first pay
  their one index.
- Opening the record index does not clear the registration rows; they are the last known load
  order, and the snapshot sent on activation corrects them. Whether Editing should read the
  profile files itself, which would move Mod override order resolution across the boundary, is
  deliberately left open.

## Alternatives rejected

- **A bulk load verb plus a verb per loadout gesture**, the state this replaced: reread for a
  mod-order change, participation for enable and disable, load and unload for unlisted copies.
  Every future gesture would need its own endpoint and its own drift story.
- **Editing reads `modlist.txt` and `plugins.txt` itself.** Self-validating like the record
  index, but puts Mod override order resolution, and "mod", inside Editing. Deferred, not refused.
