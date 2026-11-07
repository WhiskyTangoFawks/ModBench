export const MO2_INSTANCE_GUIDE = `You work in an instance: MO2's setup for one game, with its mods, profiles and downloaded files. Think of it as a package manager's install tree, which resolves conflicts with two orders.

- A mod is a folder of files that overlays the game folder. A plugin (.esp, .esm or .esl) is a file in a mod, not a mod.
- Installing a downloaded file creates a mod. The downloaded file stays.
- The mod order resolves loose files. When two mods hold the same path, the later mod wins.
- The plugin order resolves records, and the files in archives. When two plugins hold the same record, the later plugin wins.
- The load order is the two orders together.
- Overwrite is the folder of files that no mod holds, such as a file a tool wrote. It wins over every mod.
- A profile holds which mods are enabled, and both orders, in its own modlist.txt and plugins.txt. One profile is active at a time.
- MO2 gives the game its files through a virtual file system when MO2 launches it. Modbench has no virtual file system. Deploy writes the winning files to a deployment folder, and the plugin order to the game's plugins.txt.
- Never edit modlist.txt or plugins.txt by hand. MO2 owns their formats: modlist.txt lists the winning mod first, and plugins.txt lists the winning plugin last. One change often touches several files: renaming a mod changes every profile's modlist.txt. A running MO2 writes its own state over them. Change them through Modbench's tools, which write every file that depends on the change.
- Never rename or move a mod folder by hand: each profile's modlist.txt names it. Call mod_rename.
- LOOT's userlist is userlist.yaml at the instance's root. Edit it as a file.
- A mod's meta.ini and the instance's ModOrganizer.ini are MO2's, and a running MO2 rewrites them. Change what they hold through Modbench's tools.
- A publisher, such as Wabbajack, can compile the instance into a modlist that players install. Its publisher tags, such as Always Enabled, change what the modlist ships. Leave a tag as you find it unless the user asks.`;
