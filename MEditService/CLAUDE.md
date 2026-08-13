# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- Binary plugins = source of truth; DuckDB = indexed read model of committed data. Reads only via `IRecordRepository`, never Mutagen directly. Staged edits: separate table.
- Records table key: `(form_key, origin, plugin)` — one row per (origin, plugin) per FormKey. `origin` (ADR-0036, amends ADR-0006) is the mod folder that provided the file, or a reserved `PluginOrigin` value; `plugin` alone is not a unique identity. #271/#272 closed every gap deliberately left filename-only-keyed for the record editor's own single-record field reads: VMAD, conditions, header and `form_lookup` indexing/delete/winner-join (`DuckDbRecordRepository`); `IRecordReader.GetVmad`/`GetConditions`/`GetPlacement`; the `pending_changes` read/delete surface itself — `IPendingChangeService.GetChanges`, `GetPendingFields`, `RemoveFieldsWithPrefix`, `GetStagedFormKeys`, `GetPendingNativeFormKeyChanges`, `Revert`, `DrainForPlugin` all take/filter by `origin`; and `pending_form_references`. #275 closed the wire/DTO shims layered on top: `PluginResponse`/`RecordDetail`/`CompareOverride`/`PendingChangeUpsert`/`GroupMember`/`PendingChange`/`ExplicitPlugin`/`PluginMetadata` all require `Origin` (or `origin`) rather than defaulting it, and the origin-less `LoadExplicit` overloads (`GameSession`/`ISessionManager`/`SessionManager`, including the `ISessionManager` default-interface method that used to discard origin) are gone. #296 closed the remaining read surfaces (Worldspace tree, Referenced By, record listing/lookup, plugin record-type counts, ESL native-FormKey validation): `GetWorldspaceCells`/`GetInteriorCells`/`GetCellReferences`/`GetRecordForPlugin`/`CountRecordsForPlugin`/`GetNativeFormKeys` all take a required, non-nullable `origin` (plugin is never optional at any of their call sites, mirroring GetVmad/GetConditions/GetPlacement). `GetRecord` (`IRecordReader`) takes a required-but-*nullable* `origin` instead — no default, but nullable like its own nullable `plugin`, because its global-winner lookup (`IRecordQueryService.GetRecord(formKey)`) legitimately passes both as null; only `GetRecordForPlugin`, its non-nullable wrapper, gets the plain required treatment. `GetRecords`/`SearchRecords` take a nullable `origin` *filter* instead (plugin itself is optional there — browsing every plugin is legitimate — mirroring `DuckDbPendingChangeService.BuildFilter`'s own origin parameter); `RecordSummary` and `ReferenceResult` both gained an `Origin` field; `WorldspaceQueryService.GetCellReferences`'s pending-overlay call and `IRecordQueryService.GetPluginRecordTypes` resolve origin server-side via the new shared `PluginOriginResolver` (Session/) rather than taking it as a wire parameter, since no frontend caller has ever had origin to supply on these routes. `IRecordQueryService.GetChanges` lost its `plugin` parameter entirely (deleted, not origin-threaded — nothing ever called it) rather than gaining one; `formKey`/`memberChangeId` are real, kept as-is.

  #34's backend half closed the last of the compound-identity gaps *inside the session*: `GameSession` keys its opened mods by `(origin, filename)` and `GetMod` requires an origin; `AddUnlistedPlugin`/`RemoveUnlistedPlugin` + `SessionManager.LoadUnlistedPlugin`/`UnloadUnlistedPlugin` + `POST /plugins/load`/`/plugins/unload` open and index (or drop) a plugin file the effective load order does not name — read-only, non-participating, and absent from Mutagen's `LoadOrder` entirely, which refuses a second listing per ModKey. `PluginMetadata`/`PluginResponse` carry `InLoadOrder`, which `Participates` cannot express (a disabled `plugins.txt` line is still in the load order and still a legitimate write target). `IRecordIndexer.Unindex` is `Index`'s inverse, table for table — ADR-0035's "hidden means absent" is unloading, never filtering. `RecordQueryService.GetCompare`'s `pluginMasters`/`pluginParticipates` are `ColumnKey`-keyed (they threw outright on a duplicate filename, not merely mis-keyed), as are all three classifiers' participation filters. `PluginOriginResolver.Resolve` and `SessionManager.RequirePlugin` resolve **only among load-order members**, which restores the property that makes bare filenames safe as write targets: `plugins.txt` cannot list a name twice. `IEditOrchestrator.CopyRecordTo` takes `sourceOrigin` so a copy binds to the column it was invoked on. `GetRecords`/`GetPluginRecordTypes` take an optional `origin` — stated by a caller that knows which copy it is browsing, else resolved from the load order as since #296.

  Still filename-only-keyed, each out of scope for its own reason:
  - **#305** — the worldspace/interior-cell routes (`GetWorldspaces`/`GetWorldspaceBlocks`/`GetCellReferences`/`GetInteriorCells`) still resolve origin from the filename, so they answer for the wrong copy when two are loaded. `PluginTreeProvider` omits the spatial group nodes for a copy the load order does not name rather than show another file's cells.
  - **#303** — `MasterResolution.Classify` and `GetPlugins`' filter-path `matchingPlugins.Contains(p.Name)` are bare-filename-keyed, so two loaded copies report each other's master issues; the frontend's `masterIssues` map and `PluginsTreeComposite`'s session keys are filenames for the same reason.
  - **#306** — six immutability guards (`PluginSaver`, `ChangeEndpoints` ×2, `EditOrchestrator` ×3) still take the first session plugin matching a filename. Fail-safe today (an unlisted copy is immutable, so a mis-hit refuses rather than permits) but correct only by list order.
  - **#304** — mEdit's `extendedFieldEditor.ts` builds its temp-file path from `plugin` name alone despite `origin` already riding on the message.
  - **#297** — `modbench/webview/src/types.ts` hand-maintains its own duplicate of the generated wire types (`modbench/src/medit/generated/api.ts`) instead of importing them, so a wire-contract change (e.g. this ticket's `RecordDetail.Origin`) has to be applied by hand a second time in the webview or silently drift.
- DuckDB schema is reflection-generated from Mutagen types at startup — never hand-edit. Enforces root's game-generalization rule; FO4 in tests = fixture, not scope limit.
- Reads query `<type>` (generated view = committed + staged), not `<type>_committed`. Use `_committed` only for committed-only data (e.g. conflict classifier). [ADR-0025](../docs/adr/0025-reads-overlay-pending-via-views.md)
- Every write backs up the target plugin first (timestamped `.bak`) — cross-session undo depends on it; new write paths must not skip this. [ADR-0008](../docs/adr/0008-timestamped-binary-backups.md)
- FormLinks validate at stage time, not apply time — existence+type checked before entering pending-change state. [ADR-0020](../docs/adr/0020-reference-validation-at-stage-time.md)
- Partial-success endpoints return a structured failures collection (named record, e.g. `SessionLoadResponse.Failures`) — never swallow a partial outcome or use stringly-typed errors; frontend decides surfacing. [ADR-0026](../docs/adr/0026-error-surfacing-policy.md)

## Folder structure

| Folder | Owns | Examples |
| ------ | ---- | ------- |
| `Session/` | Live game environment and lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge of Mutagen record types — read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | DuckDB record index: insert committed records, query, DDL | `IRecordRepository`, `DuckDbRecordRepository`, `TableDdlBuilder`, `SessionCache` |
| `Queries/` | Application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | Staging and persisting user edits | `PendingChangeService`, `PluginWriter`, `SaveResult` |

Place code by ownership: `ColumnSpec` (`Schema/`) carries both read extractor + write Apply delegate; `PluginWriter` writes to disk, doesn't call back into the repository; DTOs in `Queries/Models.cs`. Delete dead code.

## Endpoint invariant

Every endpoint needs `.Produces<T>()` (success) + `.ProducesProblem(status)` (each error) — else Swashbuckle emits `content?: never`, TS callers get `never`. No anonymous types (`new {...}`) — named record from `Queries/Models.cs`.

## Logging (Serilog → `%LOCALAPPDATA%/mEdit/logs/`)

- Endpoint catch: `_logger.LogError(ex, "...")` before `Results.Problem(ex.Message)`; never `ex.ToString()` (leaks stack trace); never return from catch unlogged.
- Best-effort catches: `_logger.LogWarning`, no silent `catch {}` — except `SchemaReflector`'s per-call property-accessor lambdas (avoid log noise).
- Structured properties: `_logger.LogInformation("Indexed {Count} records for {Plugin}", n, name)`.
- `LogInformation` for state transitions, `LogTrace` for per-record/per-column trace.
