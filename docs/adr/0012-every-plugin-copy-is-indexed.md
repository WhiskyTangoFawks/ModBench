# Every plugin copy is indexed

The record index holds every physical plugin copy in the instance: the copy that wins its name
and the copies that lose it, the copies `plugins.txt` lists and the files no line names. The load
order filters down to which copies compete
([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)).
A mod reordered, enabled or disabled is then a flag moving between rows already indexed, never a
file re-read, which is what lets the editor follow a mod change as it happens
([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).

## Strategic invariants

1. **A plugin is identified by `(origin, filename)`.** A filename names several copies once every
   copy is indexed, so it cannot be the key. `origin` is the mod folder that provides the file,
   with reserved values for the game's `Data/` directory and MO2's `overwrite/`; vanilla, DLC and
   Creation Club plugins take the `Data/` origin, never a null key component.
2. **The column is named `origin`, not `mod`.** Editing treats an origin as an opaque string it
   never interprets. Mod Management knows an origin is a mod folder and is the only side that
   renders it. The vocabulary boundary ([CONTEXT.md](../../CONTEXT.md)) holds even though
   the boundary object sits in a primary key.
3. **Origin is never what the user reads.** The tree and the compare-grid header show the
   filename; the origin sits in the tooltip and appears inline only when two loaded copies share a
   filename. Column headers are the scarcest space in the grid, and xEdit's carry filenames alone.
4. **A plugin whose master is missing is indexed like any other, flagged, never deactivated,
   and never cascades.** Mutagen builds FormKeys from a plugin's own header, so importing never
   requires the master to exist, and a link into an absent master is a well-formed key that
   resolves to nothing. xEdit deactivates and cascades only because its object graph cannot
   resolve at all with a master missing. The Plugins tree keeps the checkbox as the user set it
   and flags the row, as MO2 does ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)),
   so the conflict picture describes the load order the user actually has, crash and all.
5. **An overridden plugin is read-only, browsable, and not a compare-grid column.** An edit to a file
   the game does not load changes nothing observable; raising the mod's priority makes the plugin
   the winner and editable in one gesture. The grid is the record's in-game resolution stack, and
   a file the game never loads is not in it.

## Alternatives rejected

- **Register only the winning copies and load losers on demand.** A second loading path and a
  second identity story for what is, to the user, the same gesture as a disabled plugin, and a
  mod-order change becomes a file re-read instead of a flag.
- **Bare filename as identity**, the original key. It holds only while one physical file can
  answer to a name.
- **Absolute path as identity.** Unstable across an instance move, unreadable, and it leaks the
  user's filesystem into every wire message.
