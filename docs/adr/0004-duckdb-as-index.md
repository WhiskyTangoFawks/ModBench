---
status: accepted
---

# DuckDB as the in-process index for record queries

DuckDB is the in-process analytical query engine for the record index. It holds a queryable read
model of all loaded records, derived from plugins (or, for a tracked mod, its source) via Mutagen.
It is a cache — deleting it loses nothing and it rebuilds on session load.

Key reasons over SQLite: columnar storage makes GROUP BY and aggregation across hundreds of
thousands of records sub-100ms (conflict detection across a 200-mod load order is a GROUP BY);
native JSON column support with path queries — what the documents model (ADR-0005) is built on;
parallel query execution; recursive CTE support for graph traversal. Still in-process like SQLite
— no separate server.

## Alternatives rejected

- **SQLite** — adequate for single-plugin editing at modest scale. JSON support is an
  afterthought; analytical queries across full load orders are slow.
- **Kuzu (graph database)** — the reference graph is genuinely a graph problem and Kuzu handles
  reachability queries more elegantly. Excluded in favor of DuckDB recursive CTEs, which are
  sufficient. Revisit if reachability analysis becomes a priority.
- **PostgreSQL / external databases** — inappropriate for a local desktop tool. No server process
  should be required.
