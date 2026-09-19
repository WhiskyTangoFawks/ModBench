Every gesture and every command, one row each. A gesture is a registered `modbench.*` entry in `package.json`.

- Kind `command`: writes state (a file, a repository or a folder) and returns. Some have no registered gesture: a dialog answer, a check box, a drag, or an automatic trigger.
- Kind `view`: changes only what a view shows, or opens something. It writes nothing.
- A toggle is one row with both directions.

Status: `built` code exists. `drawn` in the zoom-out and a trace, not built. `planned` written down, not drawn. `word-only` a word with no command. `?` not yet verified.

| Action | Kind | Gesture | Meaning | Status | Trace |
|---|---|---|---|---|---|
| edit record | command | `modbench.array.add`, `modbench.array.remove`, `modbench.array.moveUp`, `modbench.array.moveDown` | Change a record's fields in plugin source. | built | edit-a-record |
| create record | command | `modbench.record.create` | Add a record to a plugin. | built | edit-a-record |
| delete record | command | `modbench.record.delete` | Remove a record from a plugin. | built | edit-a-record |
| renumber record | command | `modbench.record.renumber` | Change a record's FormKey and every reference to it. | built | edit-a-record |
| copy record as new | command | `modbench.record.copyAsNewRecord` | Copy a record into a plugin under a new FormKey. | built | edit-a-record |
| copy record as override | command | `modbench.record.copyAsOverride` | Copy a record into a later plugin, where it overrides the original. | built | edit-a-record |
| copy record as underride | command | - | Copy a record into an earlier plugin, where it is an underride. | planned | - |
| create plugin | command | `modbench.newPlugin` | Create a plugin in a mod. | built | edit-a-record |
| open editor | view | `modbench.openEditor`, `modbench.openEditorBeside`, `modbench.openCompare`, `modbench.openHeader`, `modbench.field.openExtended` | Open a record, a comparison, a header or a field value in an editor tab. | built | - |
| filter records | view | `modbench.setFilter`, `modbench.clearFilter`, `modbench.setFilterFromDocument` | Narrow the record tree to the FormKeys a SQL query returns. | built | query |
| show referenced by | view | `modbench.showReferencedBy`, `modbench.referencedByTree.copy` | List the records that reference a record. Copy a row. | built | query |
| refresh | view | `modbench.refresh` | Re-read state from disk. | built (?) | the-instance-recomputes |
| track | command | `modbench.pluginListTree.track` | Serialize a mod's plugins to plugin source and put the mod folder under git. | built | track-a-plugin |
| compile | command | `modbench.saveAndCompile`, `modbench.pluginListTree.compileAtMain` | Write a plugin's binary from its plugin source, from the working tree or from `main`. | built | compile-a-plugin |
| commit to main | command | - | Commit an external change to `main`, then rebase the edit branch. Dialog answer. Handler name: absorb. | built | a-tracked-mod-changes-on-disk |
| apply to working tree | command | - | Apply an external change to the working tree on the current branch. Dialog answer. Handler name: keep. | built | a-tracked-mod-changes-on-disk |
| rebase edit branch | command | `modbench.pluginListTree.rebase` | Replay the edit branch onto `main`. | built | a-tracked-mod-changes-on-disk |
| repair | command | - | Rewrite a malformed plugin into its canonical form. | planned | - |
| put load order | command | - | Hand mEdit the load order snapshot. Automatic. | built | enable-a-mod |
| filter plugins | view | `modbench.pluginListTree.filter`, `modbench.pluginListTree.clearFilter` | Narrow the plugin list by name. | built | - |
| reveal plugin | view | `modbench.pluginListTree.revealInExplorer` | Show a plugin file in the file explorer. | built | - |
| enable / disable plugin | command | - | Flip a plugin's line in `plugins.txt`. Check box. | ? | enable-a-plugin |
| reorder plugins | command | - | Move a plugin in plugin order. Drag. | ? | enable-a-plugin |
| import plugin | command | - | Add a line to `plugins.txt` for a plugin on disk that lacks one. Automatic. Code name: reconcile. | built | enable-a-plugin |
| enable / disable mod | command | - | Flip a mod's line in `modlist.txt`. Check box. | ? | enable-a-mod |
| reorder mods | command | - | Move a mod in mod order. Drag. | ? | enable-a-mod |
| edit separators | command | `modbench.modList.mod.addSeparatorBelow`, `modbench.modList.separator.addSeparatorBelow`, `modbench.modList.separator.rename`, `modbench.modList.separator.delete` | Add, rename or delete a mod separator. | ? | enable-a-mod |
| move to separator | command | `modbench.modList.mod.moveToSeparator` | Move a mod under another mod separator. | ? | enable-a-mod |
| uninstall mod | command | `modbench.modList.mod.uninstall` | Remove a mod folder and its line. | ? | - |
| new empty mod | command | `modbench.modList.newEmptyMod` | Create an empty mod folder and its line. | ? | - |
| import mod | command | - | Add a line to `modlist.txt` for a folder already in `mods/`. Automatic. Code name: adopt. | built | install-a-mod |
| install mod | command | `modbench.modList.installFromArchive`, `modbench.modList.installFromFolder`, `modbench.downloads.install` | Install a downloaded file, an archive or a folder as a new mod. | ? | install-a-mod |
| upgrade mod | command | `modbench.downloads.install` | Install a downloaded file over a mod with the same Nexus id. The user confirms the target. | ? | upgrade-a-mod |
| sort direction | view | `modbench.modList.view.winningAtTop`, `modbench.modList.view.losingAtTop` | List mods with the winning end at the top or at the bottom. | built | - |
| filter mods | view | `modbench.modList.filter`, `modbench.modList.clearFilter` | Narrow the mod list by name. | built | - |
| open mod folder | view | `modbench.modList.mod.openInExplorer`, `modbench.modList.overwrite.reveal` | Show a mod's folder, or the overwrite folder, in the file explorer. | built | - |
| view on Nexus | view | `modbench.modList.mod.viewOnNexus`, `modbench.downloads.visitNexus` | Open a mod's or a downloaded file's Nexus page. | built | - |
| hide / unhide downloaded file | command | `modbench.downloads.hide`, `modbench.downloads.unhide` | Toggle a downloaded file's hidden flag in its `.meta`. | ? | - |
| delete downloaded file | command | `modbench.downloads.delete` | Delete a downloaded file. | ? | - |
| download | command | - | Fetch a mod file into `downloads/`. Modbench does not do this. | word-only | - |
| open downloaded file | view | `modbench.downloads.openFile`, `modbench.downloads.openMeta` | Open a downloaded file or its `.meta` sidecar. | built | - |
| filter downloads | view | `modbench.downloads.filter`, `modbench.downloads.clearFilter` | Narrow the downloaded files by name. | built | - |
| sort downloads | view | `modbench.downloads.sortBy` | Choose the field the downloaded files sort by. | built | - |
| show hidden downloads | view | `modbench.downloads.showHidden`, `modbench.downloads.hideHidden` | Show or hide the hidden downloaded files. | built | - |
| switch profile | command | `modbench.toolbox.switchProfile` | Change the active MO2 profile. | ? | switch-profile |
| deploy / purge | command | `modbench.toolbox.deploy`, `modbench.toolbox.purge` | Toggle between deployed and not deployed. Purge asks for confirmation. | ? | deploy |
| launch | command | `modbench.toolbox.launch` | Start the game through MO2's run list. | ? | - |
