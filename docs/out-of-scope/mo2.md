# MO2: divergences and omissions

Where MO2 has an answer, Mod Management adopts it ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)). This file lists every place it does not.

What MO2 does: [the surface audit](../research/mo2-surface-audit.md).

## Omissions by reason

| Reason | Why | Gestures | Examples |
|---|---|---|---|
| VS Code provides it | VS Code already supplies the file tab, Explorer, Open Folder, tasks, settings and the columnless tree ([ADR-0017](../adr/0017-mo2-is-the-reference-for-mod-management.md)). A mod's `meta.ini` stays editable as text. | 30 | Visit the game's Nexus page; Open folders: game, MyGames, INIs, instance, mods, profile, downloads; Switch or create an instance |
| Manual file management | The operation is a compound file operation. VS Code's file tab and Explorer do it, and Modbench does not abstract the file system away. | 10 | Rename a profile; Remove a profile; Transfer saves |
| An ADR decides it | A watcher feeds the read model, so a list needs no refresh gesture ([ADR-0015](../adr/0015-edits-reach-the-read-model-through-the-watcher.md)). Modbench never assumes it owns a file, so it never deletes one silently ([ADR-0003](../adr/0003-modbench-never-assumes-exclusive-ownership-of-a-file.md)). | 2 | Delete orphaned .meta files on refresh, without asking; Refresh the list |
| Platform | MO2 runs programs through a virtual file system. Modbench deploys with hardlinks. | 1 | Conflicts tab: preview, execute with the virtual file system |
| Scripts, tasks or the agent | The gesture runs an external tool or exports data. A task or a script does the same job. | 2 | Export to CSV; Sort with LOOT |
| Metadata chrome | The feature annotates or organizes a mod list inside MO2's UI. Separators already organize the list, and nothing in Modbench consumes the rest. | 16 | Endorse, un-endorse or decline to endorse; Start or stop tracking on Nexus; Change categories |
| Backups belong to git | Git tracks the history of a mod, the mod list and the plugin list. A backup is a git action. | 5 | Back up or restore the mod list; Back up or restore the plugin lists; Create a backup of a mod |
| Dead in MO2 | MO2 has it by accident, or it has no working effect there. | 1 | Enable or disable a separator with Space (effect inferred) |
| Maintainer ruling | The maintainer decided the gesture is unnecessary. The gesture name says why. | 5 | Lock or unlock a plugin's load-order slot (sorting rules will be relative) |

## Divergences

Gestures Modbench does differently.

| # | Where | Modbench | MO2 | Why |
|---|---|---|---|---|
| 1 | The top bar | The Toolbox, the container's first view: a small readout of the Instance's value, Profile and Deployment, with the workspace actions in its title bar ([containers.md](../specs/containers.md)) | MO2's top bar | Limitation: VS Code has no container-title contribution point. |
| 2 | Downloads | Starts collapsed. The status-bar item for the ambient glance waits for Nexus integration and the `nxm://` handler ([downloads.md](../architecture/surfaces/downloads.md)). | A tab, always visible | Ruling: Downloads is occasional, unlike Mods and Plugins. |
| 3 | Archives | No Archives view. Modbench never builds a merged view ([ADR-0002](../adr/0002-mod-management-and-editing-are-one-tool.md)). | An Archives tab | Ruling. |
| 4 | Deploy and run | The alpha does not deploy, run the game or run tools. MO2 does. After the alpha, deployment follows Vortex ([ADR-0020](../adr/0020-vortex-is-the-reference-for-deployment.md)). | Runs every program through its virtual file system | Ruling. |
| 5 | Downloads rows | Excluded rows, when shown, are dimmed | Hidden rows look like the rest | Ruling: show excluded mixes them into the list, and the dim is the only way to tell them apart. |
| 6 | Downloads order | Newest file first | By status, newest first within each | Ruling: the file just downloaded is the one wanted next. |
| 7 | Downloads selection | Several rows selected at once; delete, exclude and include act on the whole selection | One row at a time, plus bulk items: hide or delete all, installed or uninstalled, and query info for every incomplete file | Ruling: selecting several is VS Code's native way to act on many. |

## Omissions by object

Gestures Modbench does not offer. A gesture ruled out is not in [commands.md](../architecture/commands.md). Look up the object; the Reason column names the row in the table above.

### Instance

| Gesture | MO2 | Reason |
|---|---|---|
| Visit the game's Nexus page | Toolbar: Visit Nexus (Ctrl+N) | VS Code provides it |
| Open folders: game, MyGames, INIs, instance, mods, profile, downloads | Pane: Open Folders menu | VS Code provides it |
| Switch or create an instance | Toolbar: Manage Instances | VS Code provides it |
| Tools menu | Toolbar: Tools | VS Code provides it |
| Endorse MO2, notifications, update, help | Toolbar | VS Code provides it |
| Run an executable from the run box | Run box, toolbar, Run menu | VS Code provides it |
| Pin or unpin an executable on the toolbar | Run box, toolbar context menu | VS Code provides it |
| Create a desktop or start-menu shortcut for an executable | Run box: Shortcut | VS Code provides it |

### Profile

| Gesture | MO2 | Reason |
|---|---|---|
| Rename a profile | Profiles dialog | Manual file management |
| Remove a profile | Profiles dialog | Manual file management |
| Transfer saves | Profiles dialog | Manual file management |
| Profile-specific saves, game INIs and archive invalidation | Profiles dialog check boxes | Manual file management |
| Manage saves | Saves tab (not audited) | Manual file management |
| Open the Profiles dialog | Toolbar: Profiles (Ctrl+P), combo item Manage | VS Code provides it |
| Back up or restore the mod list | Pane: Create Backup, Restore Backup | Backups belong to git |
| Back up or restore the plugin lists | Plugin list: Backup, Restore | Backups belong to git |

### Mod

| Gesture | MO2 | Reason |
|---|---|---|
| Configure INI tweaks after install | Install: Configure Mod | VS Code provides it |
| Endorse, un-endorse or decline to endorse | Mod list | Metadata chrome |
| Start or stop tracking on Nexus | Mod list | Metadata chrome |
| Sync overwrite to mods | Overwrite row: Sync to Mods... | Manual file management |
| Create a mod from the overwrite content | Overwrite row: Create Mod... | Manual file management |
| Move overwrite content into a mod | Overwrite row: Move content to Mod... | Manual file management |
| Clear overwrite | Overwrite row: Clear Overwrite..., Delete | Manual file management |
| Edit the priority cell | Mod list: F2 | VS Code provides it |
| Move one step with Ctrl+Up or Ctrl+Down (keys follow VS Code, not the template) | Mod list: Ctrl + Up, Ctrl + Down | Maintainer ruling |
| Drop an archive, a folder or another mod's files onto the mod list (nothing drops into Mods from outside) | Mod list: drag and drop | Maintainer ruling |
| Restrict reordering to the priority sort | Mod list: drop refused otherwise | VS Code provides it |
| Open, rename, delete or add a folder in the overwrite files | Overwrite dialog | Manual file management |
| Edit the version, Nexus id or notes cell | Mod list: inline edit | VS Code provides it |
| Sort by column | Mod list: header | VS Code provides it |
| Group by category or Nexus id | Mod list: group combo | VS Code provides it |
| Show or hide columns | Mod list: header menu | VS Code provides it |
| Filter separators | Mod list: filter widgets | VS Code provides it |
| Filter by category | Mod list: filter widgets | VS Code provides it |
| Clear all filters | Mod list: filter widgets | VS Code provides it |
| Open in Explorer by key or double click | Mod list: Ctrl + Enter, Ctrl + double click | VS Code provides it |
| Conflicts tab: open in Explorer | Information dialog | VS Code provides it |
| Conflicts tab: preview, execute with the virtual file system | Information dialog | Platform |
| Export to CSV | Mod list: Export to csv... | Scripts, tasks or the agent |
| Change categories | Mod list: Change Categories | Metadata chrome |
| Set primary category | Mod list: Primary Category | Metadata chrome |
| Remap category from Nexus | Mod list: Remap Category | Metadata chrome |
| Auto-assign categories | Mod list: All Mods menu | Metadata chrome |
| Select or reset mod color | Mod list: Select Color..., Reset Color | Metadata chrome |
| Change versioning scheme | Mod list | Metadata chrome |
| Ignore or un-ignore an update | Mod list: Ignore update | Metadata chrome |
| Ignore missing data | Mod list | Metadata chrome |
| Mark as converted or working | Mod list | Metadata chrome |
| Visit the uploader's profile | Mod list | Metadata chrome |
| Visit a custom URL | Mod list: Visit on host | Metadata chrome |
| Create a backup of a mod | Mod list: Create Backup | Backups belong to git |
| Restore a backup over the mod | Backup row: Restore Backup | Backups belong to git |
| Remove a backup | Backup row: Remove Backup... | Backups belong to git |

### Separator

| Gesture | MO2 | Reason |
|---|---|---|
| Select all mods inside a separator | Mod list: Alt + click (a shift + click in the tree) | VS Code provides it |
| Collapse all, collapse others, expand all | Mod list: row menu | VS Code provides it |
| Expand or collapse one separator | Mod list: Shift + Enter, double click | VS Code provides it |
| Enable or disable a separator with Space (effect inferred) | Mod list: Space | Dead in MO2 |
| Select or reset separator color | Mod list: Select Color..., Reset Color | Metadata chrome |
| Change a separator's categories | Mod list: Change Categories | Metadata chrome |

### Plugin

| Gesture | MO2 | Reason |
|---|---|---|
| Lock or unlock a plugin's load-order slot (sorting rules will be relative) | Plugin list: Lock load order | Maintainer ruling |
| Edit the priority cell | Plugin list: F2 | VS Code provides it |
| Restrict reordering to the priority or mod-index sort | Plugin list | VS Code provides it |
| Sort with LOOT | Plugin list: Sort button | Scripts, tasks or the agent |

### Downloaded file

| Gesture | MO2 | Reason |
|---|---|---|
| Delete orphaned .meta files on refresh, without asking | Downloads refresh | An ADR decides it |
| Drop an archive or a URL onto the tab | Downloads: drag and drop | VS Code provides it |
| Reveal in Explorer | Downloads: Reveal in Explorer | VS Code provides it |
| Open the meta file, creating it when missing | Downloads: Open Meta File | VS Code provides it |
| Choose columns | Downloads: header menu | VS Code provides it |
| Refresh the list | Downloads: Refresh, watcher | An ADR decides it |
| Visit the uploader's profile | Downloads | Metadata chrome |
| Install by double click or Enter (the row menu is the one entry) | Downloads: double click, Enter | Maintainer ruling |
| Drag a downloaded file onto the mod list to install (the row menu is the one entry) | Downloads: drag out | Maintainer ruling |
