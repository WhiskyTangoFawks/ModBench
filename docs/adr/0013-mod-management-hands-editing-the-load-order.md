# Mod Management hands Editing the load order

Modbench's data is two layers. The file layer is the mods and their files, resolved by mod order. The record layer is the plugins and their records, resolved by plugin order. Mod Management owns the file layer and every file of the mod manager, and Editing reads none of them. So Mod Management alone decides which plugins are active, and hands Editing the load order as state, which Editing reconciles and never re-derives ([ADR-0002](0002-mod-management-and-editing-are-one-tool.md)).

## Alternatives rejected

- **A bulk load verb plus a verb per loadout gesture:** reread for a mod-order change, participation for enable and disable, load and unload for unlisted plugins. Every future gesture would need its own endpoint and its own drift story.
- **Each plugin with its slot, enabled and winning facts, and Editing derives which plugins are active**. One list carried two events, so Editing diffed it to learn which had happened. It kept a registered state between indexed and active. It re-derived a rule over Mod Management's own files.
- **Editing reads the plugins the game loads with no line, through Mutagen.** Deciding the active plugins then spans both sides, and Mod Management waits on Editing before it can send. The game's masters are a short per-release list.
- **Editing reads `modlist.txt` and `plugins.txt` itself.** Self-validating like the record index, but puts the mod manager's formats and mod order inside Editing, and `plugins.txt` alone cannot say which mod's file a name means.
