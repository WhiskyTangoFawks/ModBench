# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules; the ADR named on each line is the full statement.

```bash
# one box while iterating, through slot-run.sh; a full run goes through /validate
dotnet test MEditService.<Box>.Tests -v minimal
```

- Anything derived from the whole plugin set gates on the record index's status (`Indexer.RequireWholeSetReads`): a partial set answers wrong, not smaller.
- Typed reads reconstitute records through the codec, never the SQL views; the relational schema is a contract for the SQL door only (ADR-0005).
- Record edits refuse with a typed refusal before any source write (ADR-0019).
- Partial success is a structured failures collection, never swallowed or stringly typed (ADR-0019).
- A sort or a join that carries large documents in `body` holds them all in memory (ADR-0010). A read of many records reads their documents in batches of whole records, bounded by size. A join or a subquery does not narrow what DuckDB reads, so filter by values or parameters before a query names `body`.
- A read that spans several queries runs them in one transaction, so a write between them never changes what the read sees.
- Every endpoint declares `.ProducesProblem(status)` for each error it can return; an undeclared status reaches the TS client as `never` and nothing flags it.
