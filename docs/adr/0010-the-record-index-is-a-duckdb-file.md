# The record index is a DuckDB file

The record index is a DuckDB file that persists across launches. The vanilla masters never change, so re-indexing them on every launch would be most of a launch, and no per-record speedup gets under a minute; only not redoing the work does. DuckDB runs in-process, so no server runs beside the service. Its columnar storage makes a query across every plugin fast, and its native JSON paths query the documents ([ADR-0005](0005-the-document-is-the-record-model.md)).

## Consequences

- **The index is derived state.** A file that cannot be opened is rebuilt from the files, at the cost of one cold load. Nothing in it is migrated or repaired.

## Alternatives rejected

- **A per-plugin cache beside an in-memory index.** A second store with its own writer, reader, key and eviction policy, with every runtime mutation copied into it.
- **SQLite.** Adequate for one plugin at modest scale. JSON support is an afterthought, and analytical queries across every plugin in an instance are slow.
- **Kuzu, a graph database.** The reference graph is a graph problem, but a flat references table answers what is asked today.
- **PostgreSQL or any external database.** A local desktop tool should require no server process.
