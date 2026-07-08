# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- Binary plugins = source of truth. DuckDB is an indexed read model of committed
  (on-disk) record data — the only read path for queries, always through
  `IRecordRepository`, never Mutagen directly. Staged edits are buffered in a separate
  table.
- Records table uses `(form_key, plugin)` composite key — one row per plugin
  containing that FormKey.
- DuckDB schema is reflection-generated at startup from Mutagen types — never
  hand-edit it.
- Must support all Mutagen-supported games without code changes; tests may use FO4 as
  a concrete game.

## Folder Structure

| Folder | Owns | Examples |
| ------ | ---- | ------- |
| `Session/` | Live game environment and lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge about Mutagen record types — read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | DuckDB record index: inserting committed records, querying, DDL | `IRecordRepository`, `DuckDbRecordRepository`, `TableDdlBuilder`, `SessionCache` |
| `Queries/` | Application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | Staging and persisting user edits | `PendingChangeService`, `PluginWriter`, `SaveResult` |
| `Resolution/` | FormKey ↔ EditorID translation | `FormKeyResolver` |

Place code where **ownership** fits: `ColumnSpec` in `Schema/` carries both read extractor and Apply write delegate; `PluginWriter` writes to disk and returns without calling back into the repository; DTOs in `Queries/Models.cs`. Delete dead code.

## Endpoint Invariant

Every endpoint in `MEditService.Api/Endpoints/` needs `.Produces<T>()` for success and `.ProducesProblem(status)` for every error. Without it, Swashbuckle emits `content?: never` — TypeScript callers get `never`. Never return anonymous types (`new { ... }`); use a named record from `Queries/Models.cs`.

## Logging (Serilog → `%LOCALAPPDATA%/mEdit/logs/`)

- Every endpoint catch: `_logger.LogError(ex, "...")` before `Results.Problem(ex.Message)`. Never `ex.ToString()` (stack trace leak). Never return from catch without logging.
- Best-effort catches: `_logger.LogWarning` — no silent `catch { }`. Exception: per-call property accessor lambdas in `SchemaReflector` stay silent to avoid log noise.
- Structured properties: `_logger.LogInformation("Indexed {Count} records for {Plugin}", n, name)`.
- `LogInformation` for state transitions. `LogDebug` for per-record/per-column trace.
