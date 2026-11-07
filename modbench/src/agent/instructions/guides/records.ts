export const RECORDS_GUIDE = `Records work like source code compiled into binaries. A plugin is the binary, its plugin source is the code, and the record index is a symbol index over every plugin in the instance.

- The record index is a searchable copy of every record in every plugin. Read records through Modbench's tools. Never parse a plugin's bytes yourself.
- A FormKey is a record's identity: its origin plugin and its ID in that plugin. A FormID depends on load position, so it is not an identity.
- A plugin overrides a record by holding a whole copy of it. The plugin inherits the copy from its master, as the master was when the author made the copy.
- The copy in the later plugin wins in full: every field, not only the fields its author changed. So a later plugin can silently revert an earlier plugin's change. read_record shows each copy and the winning copy.
- An Identical To Master copy changes nothing itself, but it still wins, so it reverts every change an earlier plugin made to that record. Avoid one unless the revert is the point: a patch plugin can carry one to undo another mod's change.
- A patch plugin combines the changes of several plugins to one record. Change another author's plugin with a patch plugin. Use the vendored workflow only when a patch plugin cannot do the job.
- A Partial Form copy is the exception to the whole copy. A container copied in only to carry a child record overrides none of the container's own fields, where the game allows it.
- Some records, such as NPCs, take fields from a template record. Their template flags choose which fields. An edit to a field that the template supplies changes nothing in the game.
- Edit records in plugin source: JSON files under plugin-source/ in the source mod's source folder. Each record is one file, named by its EditorID when it has one, then its FormKey. A record's child records are in its file, except a worldspace's grid cells, which are each a file of their own.
- Modbench's reads show an edit to plugin source as soon as the file is saved, before a build. The game sees the edit only after mod_build.
- To start a patch plugin, call mod_create_empty, then mod_version_in_git to make the mod a source mod, then plugin_create in it. Copy each record that the patch overrides into it with medit.copy(plugin, form_key, destination, mode='override'), then edit the copy.
- A compiled plugin is a build artifact. Change it by changing its plugin source: a change to the compiled plugin is lost at the next build. Never edit a plugin that has no plugin source.
- plugin_decompile gives a plugin in a source mod its plugin source. mod_version_in_git makes a mod a source mod.
- A compile derives the masters and the record count. A reference to another plugin's record makes that plugin a master, and a master that nothing references drops off.
- Some older plugins list a master that no record needs, only to make it load earlier. A compile drops that master. To keep the order, add a sorting rule with plugin_load_after, which keeps the order in this instance only. Or keep a record that needs the master, which keeps the order in the plugin. That record is often an Identical To Master copy, which reverts every earlier plugin's change to it. Tell the user the risk, and follow their choice.
- After an edit, list_problems shows the problems in the plugin source you changed, including each dangling FormLink.`;
