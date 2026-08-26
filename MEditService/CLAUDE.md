# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- **A tracked plugin's source tree is the source of truth; the binary is for untracked plugins**
  (#452 / ADR-0041's #444 amendment). Session load ingests a tracked plugin by deserializing
  `source/<plugin>/` whole (#441; `Source/SourceIngest`, a designated whole-mod door) — working tree →
  Effective, git `HEAD` → Head — and never consults the binary for its *content*. Untracked plugins
  keep the binary-overlay ingest unchanged; both paths end in the same `IRecordIndex.Index` over the
  same `IModGetter`, so the read model never sees a dialect. The binary is still opened for a tracked
  plugin's *metadata* (masters, record count) and for the save path — a bounded decision, stated at
  `SessionManager.IndexOnePlugin`. An unreadable source tree degrades to the binary **and records a
  visible `PluginLoadFailure`**; a silent fallback would let a user read pre-Track content believing
  it was their source. DuckDB = indexed read model. Reads only via `IRecordReads`/`IRecordIndex`,
  never Mutagen directly.
- Records table key: `(form_key, origin, plugin)` — one row per (origin, plugin) per FormKey. `origin` (ADR-0036, amends ADR-0006) is the mod folder that provided the file, or a reserved `PluginOrigin` value; `plugin` alone is not a unique identity. #271/#272 closed every gap deliberately left filename-only-keyed for the record editor's own single-record field reads: VMAD, conditions, header and `form_lookup` indexing/delete/winner-join (`DuckDbRecordIndex`); `IRecordReads.GetPlacement` (`GetVmad`/`GetConditions` since relocated to `Queries/RecordDocumentCodecs`, #421); the `pending_changes` read/delete surface itself — `IPendingChangeService.GetChanges`, `GetPendingFields`, `RemoveFieldsWithPrefix`, `GetStagedFormKeys`, `GetPendingNativeFormKeyChanges`, `Revert` all take/filter by `origin`; and `pending_form_references`. #275 closed the wire/DTO shims layered on top: `PluginResponse`/`RecordDetail`/`CompareOverride`/`PendingChangeUpsert`/`GroupMember`/`PendingChange`/`ExplicitPlugin`/`PluginMetadata` all require `Origin` (or `origin`) rather than defaulting it, and the origin-less `LoadExplicit` overloads (`GameSession`/`ISessionManager`/`SessionManager`, including the `ISessionManager` default-interface method that used to discard origin) are gone. #296 closed the remaining read surfaces (Worldspace tree, Referenced By, record listing/lookup, plugin record-type counts, ESL native-FormKey validation): `GetWorldspaceCells`/`GetInteriorCells`/`GetCellReferences`/`GetDocument(formKey, PluginKey)` (replacing `GetRecordForPlugin`)/`GetRecordTypeCounts` (replacing `CountRecordsForPlugin`)/`GetNativeFormKeys` all take a required plugin identity — the compound `PluginKey` since #421 — plugin never optional at any of their call sites, mirroring GetPlacement. `IRecordReads.GetDocument(formKey)` is the global-winner lookup instead — #421 replaced the old nullable-`plugin`/nullable-`origin` pair with a separate no-plugin overload rather than nulling both; `GetDocument(formKey, PluginKey)` is the specific-plugin sibling that gets the plain required treatment `GetRecordForPlugin` once did. `Search(RecordQuery)` (#421, replacing `GetRecords`/`SearchRecords`) takes a nullable `PluginKey` *filter* instead via `RecordQuery.Plugin` (plugin itself is optional there — browsing every plugin is legitimate — mirroring `DuckDbPendingChangeService.BuildFilter`'s own origin parameter); `RecordSummary` and `ReferenceResult` both gained an `Origin` field; `WorldspaceQueryService.GetCellReferences`'s pending-overlay call and `IRecordQueryService.GetPluginRecordTypes` resolve origin server-side via the new shared `PluginOriginResolver` (Session/) rather than taking it as a wire parameter, since no frontend caller has ever had origin to supply on these routes. `IRecordQueryService.GetChanges` lost its `plugin` parameter entirely (deleted, not origin-threaded — nothing ever called it) rather than gaining one; `formKey`/`memberChangeId` are real, kept as-is.

  #34's backend half closed the last of the compound-identity gaps *inside the session*: `GameSession` keys its opened mods by `(origin, filename)` and `GetMod` requires an origin; `AddUnlistedPlugin`/`RemoveUnlistedPlugin` + `SessionManager.LoadUnlistedPlugin`/`UnloadUnlistedPlugin` + `POST /plugins/load`/`/plugins/unload` open and index (or drop) a plugin file the effective load order does not name — read-only, non-participating, and absent from Mutagen's `LoadOrder` entirely, which refuses a second listing per ModKey. `PluginMetadata`/`PluginResponse` carry `InLoadOrder`, which `Participates` cannot express (a disabled `plugins.txt` line is still in the load order and still a legitimate write target). `IRecordIndexer.Unindex` is `Index`'s inverse, table for table — ADR-0035's "hidden means absent" is unloading, never filtering. `RecordQueryService.GetCompare`'s `pluginMasters`/`pluginParticipates` are `ColumnKey`-keyed (they threw outright on a duplicate filename, not merely mis-keyed), as are all three classifiers' participation filters. `PluginOriginResolver.Resolve` and `SessionManager.RequirePlugin` resolve **only among load-order members**, which restores the property that makes bare filenames safe as write targets: `plugins.txt` cannot list a name twice. `IEditOrchestrator.CopyRecordTo` takes `sourceOrigin` so a copy binds to the column it was invoked on. `GetRecords`/`GetPluginRecordTypes` take an optional `origin` — stated by a caller that knows which copy it is browsing, else resolved from the load order as since #296.

  #306 extended load-order-only resolution to the six write-path immutability guards (`PluginSaver`, `ChangeEndpoints` ×2, `EditOrchestrator` ×3), which had each taken the first session entry matching a filename. They share one `IGameSession.LoadOrderPlugin(name)` (`Session/PluginOriginResolver.cs`, which `Resolve` now delegates to) and are written as a positive pattern — `is not { IsImmutable: false }` — so a name with no load-order member and an immutable one refuse through the same branch, by construction rather than by every call site remembering. Narrowing alone would have flipped these fail-safe: null reads as "not immutable", so an edit against a plugin outside the load order would have staged and then failed at save with `KeyNotFoundException`. Refusing up front is therefore a deliberate behaviour change — "not in the load order" means read-only, as ADR-0036 says — and three tests that asserted the old fail-at-save outcome by name were flipped with it. At the time, the `POST /plugins/{plugin}/records` pair still answered 404 rather than 409 when the name had no load-order member, both endpoints unwired. #427 wired the route live as `CreateRecord` (`PluginEndpoints.cs`, `ProducesProblem(409)`) on a different guard model — refusals now route through `RecordEditService.RefuseIfBlocked`/`ModFolders.TrackedOf`, not the `ChangeEndpoints`/`EditOrchestrator` guards this paragraph describes.

  #305 gave the four spatial routes (`GetWorldspaces`/`GetWorldspaceBlocks`/`GetCellReferences`/`GetInteriorCells`, `IWorldspaceQueryService`) the same optional `origin` `GetRecords`/`GetPluginRecordTypes` got under #34 — `origin ??= PluginOriginResolver.Resolve(...)` when the caller doesn't state one. `WorldspaceEndpoints` threads it as a query parameter on all four routes. On the frontend, `PluginRepository`'s four spatial methods and the node chain they build (`WorldspacesNode` → `WorldspaceNode` → `BlockNode` → `SubBlockNode` → `CellNode` → `PlacedGroupNode` → `PlacedNode`, plus `InteriorCellsNode` → `CellNode`) all carry the same optional `origin`, and `PluginTreeProvider`'s `refCache`/`interiorCache` are keyed by `(origin, plugin)` through the same `originKey` helper `pageCache`'s key already used (#34) — one copy's cached page must never be served under the other's node. `PluginTreeProvider.getPluginChildren`'s stopgap suppression of the Worldspaces/Interior-cells nodes for a copy the load order doesn't name is gone with it: a shadowed copy now browses its own spatial tree instead of having it omitted.

  Still filename-only-keyed, each out of scope for its own reason:
  - **#303** — `MasterResolution.Classify` and `GetPlugins`' filter-path `matchingPlugins.Contains(p.Name)` are bare-filename-keyed, so two loaded copies report each other's master issues; the frontend's `masterIssues` map and `PluginsTreeComposite`'s session keys are filenames for the same reason.
  - **#304** — mEdit's `extendedFieldEditor.ts` builds its temp-file path from `plugin` name alone despite `origin` already riding on the message.
  - **#297** — `modbench/webview/src/types.ts` hand-maintains its own duplicate of the generated wire types (`modbench/src/medit/generated/api.ts`) instead of importing them, so a wire-contract change (e.g. this ticket's `RecordDetail.Origin`) has to be applied by hand a second time in the webview or silently drift.
- DuckDB schema is reflection-generated from Mutagen types at startup — never hand-edit. Enforces root's game-generalization rule; FO4 in tests = fixture, not scope limit.
- **The DB is an index over documents** (#413 / ADR-0041). One `records` table holds each record's
  codec JSON as its body beside identity columns (`plugin`, `form_key`, `record_type`, `editor_id`,
  `load_order_idx`, `is_winner`, `ref`, `content_hash`); the extracted index tables (`form_lookup`,
  `form_references`, `placement`, `cell_location`, `plugins`, `header`) are populated from it at
  ingest. The reflected per-type wide tables are gone — each type's name is now a generated
  `json_extract` **view** over `records`, which is what keeps user filter SQL working unchanged.
  - **Typed reads reconstitute; they never read the views.** `GetDocument`/`GetOverrideStack`
    deserialize the document through `RecordTextCodec` and run the same `ColumnSpec.Extract`
    delegates the wide tables were filled with, so values are identical by construction. The
    published relational schema is a contract for **the SQL door only** (user filters,
    `medit.query`), never for the C# surface — the document is Mutagen's serializer shape and has no
    per-column correspondence to the reflected schema.
  - **Views carry scalar leaves only** — arrays, structs and the #263 widened columns are omitted
    (`ColumnSpec.IsViewable`): no column beats a column with broken semantics. A view never carries
    an always-NULL column.
  - **Documents name their own type exactly when their path can't** (#450, adopting the whole-mod
    door's own policy). `RecordTypeDispatch` derives path-ambiguity by reflection over the game mod
    type's group structure: a group whose element type is abstract (GLOB → GlobalFloat/GlobalBool/…)
    dispatches the abstract `<Game>MajorRecord_Serialization.SerializeWithCheck`, so the kernel
    writes its own `MutagenObjectType` discriminator; every other type dispatches its concrete
    `<Type>_Serialization.Serialize` and writes none — which is what makes a document byte-identical
    to the whole-mod folder-split path's file for the same record (`DocumentShapeParityTests`).
    Reading a GLOB back as `GlobalFloat` rather than the schema's discovery winner is preserved
    *because* the ambiguous types are precisely the ones that keep the discriminator. Every other
    document is told its type on the way in: `Deserialize*` take the index's own `record_type`, which
    is the schema table name (a GRUP signature, `"weap"`) for a schema-known type and the lowercased
    CLR type name (`"landscape"`) for the handful `SchemaReflector` excludes. Embedded child records
    keep their discriminators regardless — that is the kernel's own abstract-*field* rule
    (`ExtendedList<IPlaced>`), nothing to do with this policy.
  - **A container's document carries its embedded children** (#450 / ADR-0041's #444 amendment,
    retiring #413 D8's deep-copy-and-strip and the `ContainerStripFields` posture with it). Scope is
    Spriggit's, replicated verbatim in `SpriggitEmbedCustomizations`:
    `Cell.{Persistent,Temporary,Landscape,NavigationMeshes}` and `Worldspace.TopCell` inline;
    `Quest.{DialogBranches,DialogTopics,Scenes}` and `DialogTopic.Responses` stay folder-split on
    both doors, which is why the codec keeps its child-stream/child-folder suppressions — deleting
    them puts 1,057 directories per real Quest back in the process's working directory. Canonical
    document form is bare `\n` newlines with **nothing after the closing brace**: no trailing
    newline, on every platform. An embedded child is represented inline in its parent's document and
    also as its own `records` row extracted from it; since #452 a tracked plugin has one parse, so
    the two cannot drift apart. **Folder-split children carry real GRUP order, not #454-era tree
    order** (**#459**, superseding the "stable, not canonical" claim this bullet used to make):
    `RecordTextCodecCustomization` turns `Overall.EnforceRecordOrder` on project-wide, so every
    folder-split sibling's file name carries a leading `[N] ` prefix — its actual GRUP position, not
    filesystem-read order — for flat top-level groups and container-nested lists
    (`Quest.{DialogBranches,DialogTopics,Scenes}`, `DialogTopic.Responses`) alike. `container_child.SlotIndex`
    is now that position, exact against the binary a tracked plugin came from. **Compile restores it
    too**: a compiled binary's folder-split children come back in the tree's `[N] ` order, which is the
    original GRUP order — verified byte-for-byte on the real #369 fixture by
    `RealData/CompileRoundTripGateTests` and, independently of that byte check, by
    `RealData/DialogueOrderDamageTests` (0 permuted parents / 0 moved slots, reproducing #464's own
    harness against the tree Track actually writes). No longer allowlisted by
    `SourceIngestParityTests` — that tolerance is gone, not widened. Point writes
    (`Edits/RecordEditService` create/delete/renumber/rename) keep the prefix consistent: create,
    delete and renumber all renormalize their touched group folder to contiguous `[0..k]` as their own
    last file-system act (**#489** — survivors keep their relative order; no persistent gaps survive a
    write), and an EditorID rename carries its own old index forward unchanged.
  - The header is the one surviving per-type table: a `ModHeader` is not an `IMajorRecordGetter`, so
    it has no document to project a view over.
- **Editing is a working-tree change to text, and there is exactly one write path** (#415 /
  ADR-0041). `Edits/RecordEditService.EditField` reads the record's source file, applies the field,
  writes the file back atomically, and tells the index what landed. It reads the **file**, not the
  indexed body: ingest used to serialize from a plugin's binary overlay while the source held a deep
  parse, and the two are not always structurally identical (#369's measured 1-in-3,940 hole, on
  `GitBlobHash`), so editing the file's own bytes is what stops an edit rewriting a record's
  untouched fields into the overlay's shape. #452 dissolved that hazard for tracked plugins (one
  parse — and editing requires tracking), but reading the file stays the rule: it is the shortest
  path to the bytes being edited and keeps the write path independent of index freshness. `POST /records/{formKey}/field` is the same service's
  HTTP door — scripts and agents (ADR-0024) share the one path, they do not get a second.
  - **Refusals are typed and happen before any write** (`RecordEditRefusal`), so a refused edit
    leaves the working tree untouched. Two of them are the untracked signposting: `PluginNotTracked`
    (a mod folder with no `.git` — one Track away) and `PluginHasNoModFolder` (a Data-directory
    master, where Track does not apply and the answer is a patch plugin). They are distinct because
    each names a different way out; naming the wrong one is worse than naming none. Over HTTP they
    travel as a ProblemDetails `refusal` extension beside the detail, so an agent branches on a
    discriminator rather than on prose.
  - **FormLinks validate at edit time**, against effective state (ADR-0020 kept, relocated from
    stage time). The check is `CheckErrorBuilder` over the incoming value — the same builder the
    read model renders check errors from — so "what the editor flags" and "what it refuses to
    create" cannot drift. Scope is the reflected columns, matching the pre-#410 validator; #429
    gave a top-level FormLink *column* the same `ApplyFormLinkJson` write delegate its struct/array
    sub-field sibling already had (`SchemaReflector`'s `ProjectColumn`/`ProjectSubField`), so every
    reflected FormLink shape — top-level column, struct/array sub-field — is writable through this
    one door. VMAD Object properties and condition Form params still carry FormKeys outside the
    reflected schema and are still not checked here; that stays its own, unwidened, change.
  - **Reads validate source freshness** (`Source/SourceFreshness`, #413 D3 deferred here). Point
    reads re-check the source text before answering, catching `git restore`, checkout, rebase,
    terminal commits and hand edits — no watcher, because Modbench owns the `.git` folder and git
    never announces itself. **Both refs are re-derived**: after an external commit "committed"
    itself has moved, so a pass that refreshed only the working-tree side would leave Head serving
    bytes no ref holds. Cost is bounded by dirt, not by load order — git is consulted only for
    records the index already believes are dirty, so an unedited session runs no git processes on
    the read path.
- **The ref dimension has two values** (#415). `records` still holds exactly **one row per record
  copy**, and that row *is* `RecordRef.Effective`; the `ref` column says which state those bytes
  are, never which of several rows to pick. That is why every read and every generated
  `json_extract` view keeps answering Effective with no ref predicate anywhere, and why the SQL door
  (user filters, `medit.query`) sees what the editor sees — `WHERE "ref" = 'working-tree'` is how it
  asks for just the dirt. The committed bytes of a *diverged* record live in the
  `records_committed` difference table; `records_head` unions it with the rows that never diverged,
  giving Head a relation of the same shape, which is why `At(ref)` is a relation name rather than a
  second read implementation.
  - `is_winner` is **derived inside `records_head`**, never carried through. A record the working
    tree deleted promotes the next plugin down at Effective, and the promoted row is a clean row
    physically shared with that view — reading its stored flag reported two winners for one FormKey
    at Head.
  - `IRecordIndex.ApplyWorkingTreeChanges` moves Effective against a fixed baseline (null body =
    deletion; bytes equal to committed = convergence back to clean, by byte compare, never by a
    `content_hash` mismatch alone). `SetCommittedBaseline` moves the baseline itself. Neither can
    express the other. Both re-derive the record's extracted rows (`form_lookup`,
    `form_references`) through the same collectors ingest uses.
  - Reads that answer from the **extracted** tables (`Resolve`, `GetReferencedBy`, `GetPlacement`)
    and the header table answer identically at both refs, deliberately: those carry no ref
    dimension and track Effective, which is the answer their consumers want.
- **`SourceRepository.CommittedSourceHashes`/`ReadCommittedSourceText` ask what `HEAD` holds** — not
  what the working tree holds against the index, which is #417's `WorkingTreeStatus` (as are
  `CommitPristineToMain` and the rebase verbs). The two diverge after exactly the events these
  exist for: an external commit, rebase or amend moves `HEAD` without touching a file. Hash values
  are directly comparable to `records.content_hash` with no conversion — both are git blob object
  names, which is why that column stores git's own hash.
- **The record-index seam is `IRecordReads`/`IRecordIndex`** (#421), replacing `IRecordRepository`/
  `IRecordReader`/`IRecordIndexer` and absorbing the query service's read-model pass-throughs
  (`GetRecordForPlugin`/`GetRecordType`/`GetNativeFormKeys`/`GetPlacement`/`GetVmad`/`GetConditions` —
  all endpoint-orphaned, deleted rather than kept as redundant forwarding; VMAD/condition
  reconstitution survives at the query-service level, `Queries/RecordDocumentCodecs`, operating on
  `RecordDocument.Body` — rejected from the seam itself, same as raw SQL). `PluginKey(Name, Origin)`
  is the compound identity on every seam member, ingest included, replacing every bare
  `(string plugin, string origin)` pair. `IRecordIndex.At(RecordRef)` repositions every read; #421
  ships `RecordRef.Head` answering identically to the default `RecordRef.Effective` (both map onto
  the single `SourceRef.Committed` value `records.ref` carries) — inert until #415 gives them
  independent state. No `Connection` property and no SQL crosses this seam except `SetFilter`
  (invariant 8) — the concrete `DuckDbRecordIndex` keeps one, for white-box tests only.
- Every write backs up the target plugin first (timestamped `.bak`) — cross-session undo depends on it; new write paths must not skip this. [ADR-0008](../docs/adr/0008-timestamped-binary-backups.md)
- FormLinks validate at **edit** time, not apply time — existence+type checked before anything is written. The pending-change state that ADR-0020 named is retired (ADR-0041); the rule moved with it, see the edit-path invariant above. [ADR-0020](../docs/adr/0020-reference-validation-at-stage-time.md)
- Partial-success endpoints return a structured failures collection (named record, e.g. `SessionLoadResponse.Failures`) — never swallow a partial outcome or use stringly-typed errors; frontend decides surfacing. [ADR-0026](../docs/adr/0026-error-surfacing-policy.md)
- **A session is readable while it is still loading** (#274 / ADR-0035). `SessionManager` publishes the session and repository *before* the indexing loop, and `GameSession.OpenAll()` opens one plugin at a time, so each plugin's records become queryable the moment it is indexed. Three consequences bind new code:
  - **Anything derived from the whole plugin set must gate on `ISessionManager.Status`**, not compute over whatever is loaded so far. A partial set does not give a smaller answer, it gives a *wrong* one — `MasterResolution.Classify` over a mid-load session reports a master that simply has not been opened yet as `DirectlyMissing` (`RecordQueryService.GetPlugins` gates on `SessionState.Ready` for exactly this). `ConflictsComputed` is the same rule for winners: it is a separate field from `State` because ADR-0035's live mutations (reorder, enable, disable) will leave a Ready session with stale winners.
  - **Everything a reader touches on `GameSession` is an immutable snapshot** (copy-on-write under `_mutation`), because readers now walk those lists while the load appends to them. A plain `List<T>` here throws "Collection was modified" as often as a read coincides with a plugin landing.
  - **Never dispose a session or repository without draining the load first.** `EnterExclusive()` cancels the in-flight load *and waits for it to stop*; disposing a DuckDB connection while the indexing loop still holds it is a native crash, not a catchable exception. `Unload`, `Dispose` and every load path go through it.
  `POST /session/load` and `/session/load-explicit` stay blocking and unchanged — still the completion signal, returning only after the winner sweep; `GET /session/status` reports progress alongside the in-flight POST (200 with state `None` when idle, so a poller never reads an error to learn nothing is happening). A superseded or cancelled load answers 409, never 500.

## Folder structure

| Folder | Owns | Examples |
| ------ | ---- | ------- |
| `Session/` | Live game environment and lifecycle | `GameSession`, `SessionManager`, `PluginMetadata` |
| `Schema/` | Static knowledge of Mutagen record types — read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec`, `FieldMetadataMapper` |
| `Records/` | DuckDB index over documents: ingest, query, DDL + view generation | `IRecordReads`, `IRecordIndex`, `DuckDbRecordIndex`, `PluginKey`, `TableDdlBuilder`, `RecordViewBuilder` |
| `Queries/` | Application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | The single write path: one field edit becomes a working-tree change; compile turns source text back into the binary (#416) | `RecordEditService`, `RecordFieldWriter`, `RecordEditResult`, `PluginWriter`, `PluginCompileService`, `SourceCheckout` |
| `Serialization/` | Per-record text source codec (ADR-0041, née ADR-0040 stage 1) | `RecordTextCodec`, `RecordTextCodecCustomization` |
| `Source/` | The repo-layer verb surface over a mod folder's own (non-hidden) git repo, the Track gesture that populates it, read-time freshness over its text, and external-change classification/absorption (ADR-0041, #414–#417) | `SourceRepository`, `TrackService`, `SourceFreshness`, `ModFolders`, `GitCli`, `PristineFile`, `ContainerChildFields`, `CompileJournal`, `ExternalChangeClassifier`, `ExternalChangeDeferral` |

`MEditService.Bridge` is a separate thin assembly (#417): the live `FileSystemWatcher`
lifecycle plus the pending-external-change queue, nothing else — it references only
session/DB-free Core surfaces, enforced by `BridgeKnowsNothingOfSessionsTests`.

Place code by ownership: `ColumnSpec` (`Schema/`) carries both read extractor + write Apply delegate; `PluginWriter` writes to disk, doesn't call back into the repository; DTOs in `Queries/Models.cs`. Delete dead code.

## Endpoint invariant

Every endpoint needs `.Produces<T>()` (success) + `.ProducesProblem(status)` (each error) — else Swashbuckle emits `content?: never`, TS callers get `never`. No anonymous types (`new {...}`) — named record from `Queries/Models.cs`.

## Logging (Serilog → `%LOCALAPPDATA%/mEdit/logs/`)

- Endpoint catch: `_logger.LogError(ex, "...")` before `Results.Problem(ex.Message)`; never `ex.ToString()` (leaks stack trace); never return from catch unlogged.
- Best-effort catches: `_logger.LogWarning`, no silent `catch {}` — except `SchemaReflector`'s per-call property-accessor lambdas (avoid log noise).
- Structured properties: `_logger.LogInformation("Indexed {Count} records for {Plugin}", n, name)`.
- `LogInformation` for state transitions, `LogTrace` for per-record/per-column trace.
- Config loads from the binary's own directory (`ContentRootPath = AppContext.BaseDirectory` in `Program.cs`), not the launcher's cwd — the extension spawns us without one, and the default made `appsettings.json` silently not load at all (#343).
- Per-request logging is one summary line from `UseSerilogRequestLogging`, not ASP.NET Core's six-line pipeline (`Microsoft.AspNetCore: Warning` in `appsettings.json` silences that; the middleware writes under its own category, so the override doesn't reach it). Levels: Debug for success, Warning for 4xx, Error for 5xx/unhandled. Endpoint guards and `StageEditResultExtensions.ToHttpResult` return 4xx **without logging anything themselves**, so this middleware is the only thing making a deliberate failure visible — don't drop or reflag it without replacing that.
