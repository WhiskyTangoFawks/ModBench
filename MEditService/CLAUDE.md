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
- Every endpoint declares `.ProducesProblem(status)` for each error it can return; an undeclared status reaches the TS client as `never` and nothing flags it.
