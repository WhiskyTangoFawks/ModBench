# MEditService.Index

Record index. One deep module: a derived store over the plugin files and the source tree,
rebuildable at any time. It hides the Indexer and the Store. The Indexer asks the load order and the schema, and
decides nothing. The Store is DuckDB. Queries read the index, set its filter and rebuild it. The
Mod watcher tells it what changed. No other box calls it.
