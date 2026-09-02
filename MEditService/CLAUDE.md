# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

The ADR is the full statement — read it before changing its area.

- **A tracked plugin's source tree is its source of truth; the binary serves untracked plugins**
  (ADR-0041, ADR-0042). At first ingest an unreadable source tree degrades to the binary with a
  visible `PluginLoadFailure`, never silently. At re-ingest it does not — there are already
  source-derived rows to protect, so the failure is recorded and rethrown rather than the rows
  overwritten with stale compiled content.
- **Plugin identity is compound, everywhere** (ADR-0036): `PluginKey(Name, Origin)` on every seam
  member, wire DTO and cache key — a bare filename is never an identity.
- **Registration is visibility** (ADR-0001): a plugin answers a read iff it has a `registrations`
  row. The index is a persistent per-MO2-instance file that validates itself on open — content
  hashes, never `mtime`; a file another process holds answers `423 Locked`, never rebuilt over.
- **`PUT /load-order` is the only way the load order arrives** (ADR-0044), and the load order is
  readable while it reconciles (ADR-0035): anything derived from the whole plugin set gates on
  `ILoadOrderMirror.Status` — a partial set gives a *wrong* answer, not a smaller one.
- **The DB is an index over documents** (ADR-0041): each `records` row is the record's codec
  JSON; extracted tables and generated views derive from it. The relational schema is a contract
  for the SQL door only — typed reads reconstitute through the codec, never the views (ADR-0005).
- **One write path** (ADR-0041): `Edits/RecordEditService.EditField`. Refusals are typed and
  precede any write; every write backs up the target binary first (ADR-0008).
- Per-type views, field metadata and the codec are reflection-generated from Mutagen types at
  startup (ADR-0005, ADR-0032) — never hand-edit. FO4 in tests = fixture, not scope.
- Partial success = structured failures collection, never swallowed or stringly-typed; the
  frontend decides surfacing (ADR-0026).
- test fixtures need to be approved. Never inline into git a file that hasn't been approved.

## Endpoints

Every endpoint needs `.Produces<T>()` (success) + `.ProducesProblem(status)` (each error) — else
Swashbuckle emits `content?: never` and TS callers get `never`. No anonymous types — named record
from `Queries/Models.cs`.
