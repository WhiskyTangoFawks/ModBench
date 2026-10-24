# Masters are derived from content

A recorded divergence from [ADR-0018](0018-xedit-is-the-reference-for-record-editing.md). xEdit offers Add, Sort and Clean Masters as user actions because it patches stored FormID bytes in place, so a master list can drift from the references in the file. Mutagen rebuilds a plugin's master list from its object graph on every write and re-derives every FormID's master index from it, so there is no drift to manage: sort and clean are what every compile does.

## Consequences

- Nothing edits a master list directly, not a gesture and not a script. A reference to another plugin's record makes that plugin a master at the next compile, and a master nothing references leaves.

## Alternatives rejected

- Add Masters as a user action, for the real pattern of declaring an otherwise-unused plugin as a master purely to pin load order. That is a load-order concern, Mod Management's job, expressed invisibly inside an Editing object, per plugin, unauditable from `plugins.txt`, and it silently breaks when the referenced plugin updates. The supported way is Mod Management's own load-order surface.
