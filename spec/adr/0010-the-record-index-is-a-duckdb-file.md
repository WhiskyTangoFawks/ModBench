# The record index is a DuckDB file

The record index is a DuckDB file that persists across launches. The vanilla masters never change, so re-indexing them on every launch would be most of a launch, and no per-record speedup gets under a minute; only not redoing the work does. DuckDB runs in-process, so no server runs beside the service. Its columnar storage makes a query across every plugin fast, and its native JSON paths query the documents ([ADR-0005](0005-the-document-is-the-record-model.md)).

## Consequences

- The record index is derived state. A file that cannot be opened is rebuilt from the files, at the cost of one cold load. Nothing in it is migrated or repaired.
- The record index queries the keys it knows together. Columnar storage makes a query of one key costly.
- mEdit bounds the memory of a query it writes by the copies of its largest record, never by how many records the query reads. DuckDB cannot spill a large document that a sort or a join carries.
- A SELECT that a user or an agent writes can select every document in the record index. The memory mEdit holds for its rows never grows with how many it selects.

## Alternatives rejected

- A per-plugin cache beside an in-memory index. A second store with its own writer, reader, key and eviction policy, with every runtime mutation copied into it.
- SQLite. A lookup of one key is fast, but a query across every plugin is slow, and its JSON support is an afterthought.
- Kuzu, a graph database. The reference graph is a graph problem, but a flat references table answers what is asked today.
- PostgreSQL or any external database. A local desktop tool should require no server process.
