# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide rules; the ADR named on
each line is the full statement.

- Anything derived from the whole plugin set gates on `IQueryIndex.Status`: a partial set
  answers wrong, not smaller (ADR-0013).
- Typed reads reconstitute records through the codec, never the SQL views; the relational schema
  is a contract for the SQL door only (ADR-0011, ADR-0007).
- Record edits refuse with a typed refusal before any source write (ADR-0007).
- Partial success is a structured failures collection, never swallowed or stringly typed
  (ADR-0019).
- Every endpoint declares `.ProducesProblem(status)` for each error it can return; an undeclared
  status reaches the TS client as `never` and nothing flags it.
