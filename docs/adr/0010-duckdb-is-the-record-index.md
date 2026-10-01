# DuckDB is the record index

DuckDB is the query engine for the record index ([ADR-0009](0009-the-record-index-mirrors-the-files-on-disk.md), [ADR-0011](0011-the-record-index-stores-documents.md)). It is in-process, so no server runs beside the service. Its columnar storage makes aggregation across every plugin in an instance fast, and its native JSON path queries are what the documents model is built on.

## Alternatives rejected

- **SQLite.** Adequate for one plugin at modest scale. JSON support is an afterthought, and analytical queries across every plugin in an instance are slow.
- **Kuzu, a graph database.** The reference graph is a graph problem, but a flat references table answers what is asked today.
- **PostgreSQL or any external database.** A local desktop tool should require no server process.
