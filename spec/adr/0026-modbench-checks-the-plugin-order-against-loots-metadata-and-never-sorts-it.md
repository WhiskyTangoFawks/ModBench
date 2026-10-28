# Modbench checks the plugin order against LOOT's metadata and never sorts it

The user owns the plugin order, and a tool that sorts it takes that control away. LOOT's metadata is the ecosystem's language for sorting rules: LOOT reads it, MO2 hands its sorting to LOOT ([ADR-0017](0017-mo2-is-the-reference-for-mod-management.md)), and Vortex keeps its rules in LOOT's userlist format. So Modbench reads LOOT's metadata as its sorting rules, judges the plugin order the user has against them, and takes LOOT as the reference for what a sorting rule means and says.

## Consequences

- The game's own rules, such as a master loading before its dependants, are sorting rules in the same system, and no other box judges the order. The game's rules cannot be turned off.
- A sorting rule names a plugin by its file name, as LOOT and the game do. It judges the active plugin of that name, which is unique, and a broken rule names that plugin as `(origin, filename)` ([ADR-0012](0012-index-every-plugin-filter-to-the-active-ones.md)). A plugin is present when mod order resolves a file of that name, as LOOT sees the Data folder.
- The facts a condition reads come from mEdit and the instance, never from a parser of LOOT's. Mutagen still decides the data ([ADR-0004](0004-mutagen-is-the-parser.md)).
- The userlist is the instance's, so git holds it. LOOT's global userlist is not read: it is one per machine, and git cannot see it.
- The masterlist is pinned in the instance, so a sorting rule changes only with a diff. To disagree with the masterlist, the user edits that copy. LOOT's format lets a userlist add to the masterlist but never remove from it.

## Alternatives rejected

- libloot as the engine. It reads the Data folder and parses plugins itself. That is a second parser beside Mutagen ([ADR-0004](0004-mutagen-is-the-parser.md)), in Mod Management, which interprets no plugin binary ([ADR-0013](0013-mod-management-hands-editing-the-load-order.md)). It judges an order only by sorting it, and drops a broken group in silence. It has no .NET binding and no Linux release.
- A rule language of Modbench's own. LOOT, MO2 and Vortex share LOOT's, and a new one gives that up.
