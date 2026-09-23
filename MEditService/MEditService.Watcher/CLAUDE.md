# MEditService.Watcher

Mod watcher. The one listener to a load-order change: each change re-arms one watcher per mod folder
in the snapshot, the Source adapter naming the paths, and reconciles the record index. It settles
each mod's changes and routes every settled path, whether plugin bytes, source, git refs or anything
else in a tracked mod, to the record index or to Commands. It announces nothing, and nothing sends
it a message.
