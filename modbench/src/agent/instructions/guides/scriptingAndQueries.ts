export const SCRIPTING_AND_QUERIES_GUIDE = `The record index works like an analytical columnar database, and medit is its client library.

- help(medit) lists medit's functions, and its source is medit.py in the folder that PYTHONPATH names. Another language calls the HTTP API, whose reference is at http://127.0.0.1:$MEDIT_PORT/swagger.
- The record index is DuckDB, which stores data by column. A SELECT reads each column that it names for every row that its filters keep.
- A join or a subquery does not narrow what DuckDB reads. A SELECT whose join carries body, or a field of a record type's view, which is read from body, reads every record in the load order and can run out of memory.
- Query in two steps:
  1. SELECT the keys that you need. Filter by values such as the plugin, its origin and the FormKey.
  2. SELECT body, or the fields, for those keys as a literal list.
- A SELECT reads only the views. view_columns lists each view and its columns, and is_active says whether a row's plugin is active.
- Read in bulk: one select returns many records, and compare takes a list of FormKeys. To find the copies identical to their master, call compare, which gives each copy's state against its master. Do not compare bodies in SQL.
- edit, copy and delete write one record's plugin source per call. Select first, then write only the records that need the change.`;
