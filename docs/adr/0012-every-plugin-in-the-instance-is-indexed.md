# Every plugin in the instance is indexed

The record index holds every plugin in the instance: each plugin in every mod, enabled or disabled; each in Overwrite; and each in the game folder, listed or not. The load order does not decide what is indexed. It decides the active plugins: the plugins the game loads, in load order ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)). Every read of a record sees only the active plugins. A view shows only their records. The record filter's SQL sees only their rows. Only they compete for winners, conflicts, references and master issues. A plugin leaves the index only when its file leaves. Reordering, enabling or disabling a mod changes the active plugins. It never re-reads a file or drops a row. That is what lets the editor follow a mod change as it happens ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).

## Strategic invariants

1. **A plugin is identified by `(origin, filename)`.** Once every plugin is indexed, one filename can name several plugins, so it cannot be the key. `origin` is the mod folder that provides the file, with reserved values for the game's `Data/` directory and Overwrite. Vanilla, DLC and Creation Club plugins take the `Data/` origin, never a null key component. A filename compares as the game compares it, ignoring case, on every platform.
2. **The column is named `origin`, not `mod`.** The game's `Data/` folder and Overwrite are origins and not mods. An origin that is a mod is that mod's folder, where its repository lives.
3. **Origin is never what the user reads.** The tree and the compare-grid header show the filename; the origin sits in the tooltip. Column headers are the scarcest space in the grid, and xEdit's carry filenames alone.
4. **An active plugin whose master is not active is indexed like any other, flagged, never deactivated, and never cascades.** Mutagen builds FormKeys from a plugin's own header, so importing never requires the master to exist, and a link into an absent master is a well-formed key that resolves to nothing. xEdit deactivates and cascades only because its object graph cannot resolve at all with a master missing. The Plugins tree keeps the checkbox as the user set it and flags the row, as MO2 does ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)), so the conflict picture describes the load order the user actually has, crash and all.
5. **A plugin that is not active is read-only, shown only on request, and not a compare-grid column.** An edit to a file the game does not load changes nothing observable. Enabling its line, or moving its mod toward the winning end, makes it active and editable in one gesture. The grid is the record's in-game resolution stack, and a file the game never loads is not in it.

## Alternatives rejected

- **Index only the active plugins and read the rest on demand.** A second reading path and a second identity story for what is, to the user, the same gesture as a disabled plugin, and a mod-order change becomes a file re-read instead of a filter change.
- **Bare filename as identity.** It holds only while one physical file can answer to a name.
- **Absolute path as identity.** Unstable across an instance move, unreadable, and it leaks the user's filesystem into every wire message.
