# MEditService.Index

Record index. One deep module: a derived store over the plugin files and the source tree,
rebuildable at any time. It hides the Indexer, which asks the load order and the schema and decides
nothing, and the Store, DuckDB. Queries read it and the Mod watcher tells it what changed; no other
box calls it.
