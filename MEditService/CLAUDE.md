# MEditService

C# ASP.NET Core backend. Root [CLAUDE.md](../CLAUDE.md) for project-wide invariants.

## Invariants

- **A tracked plugin's source tree is the source of truth; the binary is for untracked plugins**
  (ADR-0041). Reconcile ingests a tracked plugin by deserializing `source/<plugin>/` whole
  (`Source/SourceIngest`, the designated whole-mod door) — working tree → Effective, git `HEAD` →
  Head — and never consults the binary for its *content*. Untracked plugins use the binary-overlay
  ingest; both paths end in the same `IRecordIndex.Index` over the same `IModGetter`, so the read
  model never sees a dialect. The binary is still opened for a tracked plugin's *metadata* (masters,
  record count) and for the save path — a bounded decision, stated at
  `LoadOrderMirror.IndexOnePlugin`. An unreadable source tree degrades to the binary **and records
  a visible `PluginLoadFailure`**; a silent fallback would let a user read pre-Track content
  believing it was their source. DuckDB = indexed read model. Reads only via
  `IRecordReads`, obtained from `IRecordIndex.At(RecordRef)`, never Mutagen directly.
- **Plugin identity is compound, everywhere** (ADR-0036 amends ADR-0006). The records table key is
  `(form_key, origin, plugin)`: `origin` is the mod folder that provided the file or a reserved
  `PluginOrigin` value; a bare filename is never an identity. `PluginKey(Name, Origin)` is the
  type on every seam member, wire DTO and cache key — `PluginResponse`/`RecordDetail`/
  `CompareOverride`/`PluginMetadata` all require `Origin`; the frontend's page/spatial caches key by
  `(origin, plugin)`. `LoadOrder` keys its held mods by `(origin, filename)`; two copies of one
  filename are ordinarily held at once (ADR-0044: the snapshot is every physical copy), and the
  losing one is read-only and non-participating — `PluginMetadata.InLoadOrder`/`Participates` are
  derived from its `Registration(LoadOrderIndex, Enabled, Winning)`, never stored (a disabled
  `plugins.txt` line is still in the load order and still a legitimate write target; a losing copy
  is not). **Registration is visibility** (ADR-0001): a plugin
  answers a read iff it has a `registrations` row. The physical tables live in the `mirror`
  schema; every public relation (`records`, `records_head`, the extracted tables, every generated
  per-type view) is a view over its mirror table through the one registered-predicate
  (`TableDdlBuilder.CreateRegisteredViews`), so the C# seam and the SQL door cannot scope
  differently. Writers name `mirror.` explicitly. ADR-0035's "hidden means absent" is
  **unregistered, never answering** — `IRecordIndex.Unregister` removes the `registrations` row
  and nothing else; `Unindex` is `Index`'s inverse and the **file-gone** verb (delete, uninstall,
  missing at validation), never the meaning of unload.
  - **The index is a persistent file per MO2 instance, and it validates itself on open**
    (ADR-0001). `IndexFile.For` puts it at `<instance>/modbench/index.duckdb`, so every
    profile in one instance shares it (a profile switch stays cheap) and no two instances can ever
    share one: `origin` is a mod folder *name*, unique only within an instance, and every mirror
    table is keyed `(plugin, origin)`. The instance root arrives on the load request and rides
    `ILoadOrder.InstanceRoot`; an index handed no instance is in-memory, which is what the suite's
    fixtures use. **`PUT /load-order` → `LoadOrderMirror.Reconcile` is the only way the load order
    arrives** (ADR-0044): Modbench manages an MO2-style instance and nothing else, and a snapshot
    that can name no mod folders can key no index. A snapshot for a different instance replaces
    what is held; the same instance reconciles in place — new `(name, origin)` opened and
    registered (indexed only if never seen), absent unregistered, moved re-registered SQL-only,
    then one winner sweep; an identical snapshot is a no-op.
    `registrations` is **the load order and nothing else** — the file facts live in `mirror.files`
    (`file_path`, `content_hash`, `index_version`), a separate table precisely so that
    unregistering a plugin does not throw away what makes re-registering it cheap. Registrations
    are **not** cleared on open (ADR-0044): they are the last known load order, and the first
    reconcile from Mod Management corrects them. `Initialize` rehashes every
    indexed file — **content, never `mtime`** — and `Unindex`es any plugin whose file is gone or
    whose bytes moved; a version mismatch (`IndexVersion`: hand-bumped format const + Mutagen
    assembly version + reflected-schema digest) or a file DuckDB cannot open rebuilds the whole
    file. **Bump `IndexVersion.FormatVersion` when you change `TableDdlBuilder`'s fixed tables or
    the codec's conventions** — `CREATE TABLE IF NOT EXISTS` will otherwise meet an old file's
    column list in silence. **A file another process holds is never rebuilt over** (ADR-0001
    point 6): DuckDB's lock error (`IndexStore.IsAnotherWriter`) becomes
    `IndexHeldElsewhereException`, which `PUT /load-order` answers `423 Locked` and the mirror
    holds nothing — deleting a locked file succeeds on POSIX and would destroy the other window's
    live index. The lock is per *process* (DuckDB.NET shares one database per path in-process), so
    the test for it holds the file from a second process (`TestSupport/ForeignIndexHolder`,
    `python3` on PATH — a test prerequisite, not a runtime one; those tests skip without it).
  - **Reconcile is registration** (ADR-0001). `LoadOrderMirror.Reconcile` indexes
    only what the file has never seen or whose bytes moved (validation already dropped those) and
    `Register`s everything else at its `plugins.txt` position — a `registrations` row, no re-index.
    A tracked plugin never takes that path however current its binary: its source tree is its truth
    (ADR-0041/0042), so `SourceIngest.TreeFor` is resolved once per plugin in the loop and gates
    the decision. Registered plugins count toward `Status.IndexedPlugins` exactly as indexed ones
    do, so a warm launch's progress advances instead of sitting at zero.
  - **The mirror keeps running while the load order does** (ADR-0001).
    `ExternalChangeWatcher.WatchIndexed` covers every *indexed* binary the game's `Data/` included,
    beside the classification watches for tracked ones; a settle re-hashes and raises
    `IndexedBinaryChanged` only when the bytes actually moved (a touch costs nothing), and a
    deletion is its own `IndexedBinaryChange.Deleted`. `MEditService.Api`'s `IndexMirror` turns
    those into `ILoadOrderMirror.ReindexPlugin(PluginKey)` / `UnindexPlugin` — the composition
    root's job, since the Bridge knows nothing of load orders or DuckDB. **Tracked plugins are
    deliberately not mirrored**: their rows come from the source tree, so their binary changing
    stays the user's Absorb/Keep question and re-reading it would overwrite the working tree with
    the compiled artifact. `ExternalChangeLoadOrderHook.RunAfterReconcile` drops every mirror watch
    before re-registering, so no watch outlives the load order that asked for it.
  - **Write targets resolve only among load-order members** (`PluginOriginResolver.Resolve`,
    the `LoadOrderPlugin` extension method on `ILoadOrder`
    (`PluginOriginResolver.cs`, not an interface member): `plugins.txt` cannot list a
    name twice, which is what makes a bare filename safe as a write target. "Not in the load order"
    means read-only, refused up front through `RecordEditService.RefuseIfBlocked` — never a
    fail-at-save.
  - Read routes (records, record types, the four spatial routes) take an optional `origin`,
    resolved server-side from the load order when the caller doesn't state one; `Search(RecordQuery)`
    takes a nullable `PluginKey` *filter* — browsing every plugin is legitimate.
  - Known residue, still filename-only-keyed: `MasterResolution.Classify` and `GetPlugins`' filter
    path.
- The per-type views, editor field metadata and record codec are reflection-generated from Mutagen
  types at startup (ADR-0005, ADR-0032) — never hand-edit. Enforces root's game-generalization
  rule; FO4 in tests = fixture, not scope limit.
- **The DB is an index over documents** (ADR-0041). One `records` table holds each record's
  codec JSON as its body beside identity columns (`plugin`, `form_key`, `record_type`, `editor_id`,
  `ref`, `content_hash`); the extracted index tables (`form_lookup`,
  `form_references`, `placement`, `cell_location`, `container_child`)
  are populated from it at ingest. Since #631 the plugin header is an ordinary `records` row too —
  there is no separate header table. `registrations` is not an extracted index table: it is the
  load-order-mirror table itself (ADR-0001), populated by `Reconcile`/`Register`, never derived
  from `records`. Each record type's name is a generated `json_extract` **view**
  over `records`, which is what keeps user filter SQL working unchanged.
  **Nothing load-order-derived is stored on a data row** (ADR-0001): a record row carries
  file-derived facts only. `load_order_idx` is a fact about a plugin's registration and lives solely
  on `registrations`; `is_winner` is a fact about the registered stack a FormKey sits in and lives
  solely in `winners` (`(record_ref, form_key) → (plugin, origin)`, rebuilt wholesale by
  `DuckDbRecordIndex.UpdateWinners`). The registered view over each mirror table (`records`,
  `records_committed`, `form_lookup` — see "Registration is visibility" above) joins both
  back in, so they still read as ordinary columns everywhere outside `Records/` itself. Every writer
  that moves a row into or out of a ref's stack must resweep — that is why `MarkWorkingTreeOnly` and
  `SeedCommittedOnly` call `UpdateWinners` even though Effective is untouched.
  - **Typed reads reconstitute; they never read the views.** `GetDocument`/`GetOverrideStack`
    deserialize the document through `RecordTextCodec` and run the same `ColumnSpec.Extract`
    delegates the extracted tables were filled with, so values are identical by construction. The
    published relational schema is a contract for **the SQL door only** (user filters,
    `medit.query`), never for the C# surface — the document is Mutagen's serializer shape and has no
    per-column correspondence to the reflected schema.
  - **Views carry scalar leaves only** — arrays, structs and the widened text columns are omitted
    (`ColumnSpec.IsViewable`): no column beats a column with broken semantics. A view never carries
    an always-NULL column.
  - **Documents name their own type exactly when their path can't.**
    `RecordTypeDispatch` derives path-ambiguity by reflection over the game mod
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
  - **A container's document carries its embedded children** (ADR-0041, ADR-0042 — one document per
    cell is the tree a human wants), in `CellEmbedCustomization`/`WorldspaceEmbedCustomization`
    (`Serialization/EmbedCustomizations.cs`):
    `Cell.{Persistent,Temporary,Landscape,NavigationMeshes}` and `Worldspace.TopCell` inline;
    `Quest.{DialogBranches,DialogTopics,Scenes}` and `DialogTopic.Responses` stay folder-split on
    both doors, which is why the codec keeps its child-stream/child-folder suppressions — deleting
    them puts 1,057 directories per real Quest back in the process's working directory. Canonical
    document form is bare `\n` newlines with **nothing after the closing brace**: no trailing
    newline, on every platform. An embedded child is represented inline in its parent's document and
    also as its own `records` row extracted from it; a tracked plugin has one parse, so
    the two cannot drift apart. **Folder-split children carry real GRUP order**:
    `RecordTextCodecCustomization` turns `Overall.EnforceRecordOrder` on project-wide, so every
    folder-split sibling's file name carries a leading `[N] ` prefix — its actual GRUP position, not
    filesystem-read order — for flat top-level groups and container-nested lists
    (`Quest.{DialogBranches,DialogTopics,Scenes}`, `DialogTopic.Responses`) alike.
    `container_child.SlotIndex` is that position, exact against the binary a tracked plugin came
    from. **Compile restores it too**: a compiled binary's folder-split children come back in the
    tree's `[N] ` order, which is the original GRUP order — verified byte-for-byte on a real fixture
    by `RealData/CompileRoundTripGateTests` and, independently of that byte check, by
    `RealData/DialogueOrderDamageTests` (0 permuted parents / 0 moved slots). Point writes
    (`Edits/RecordEditService` create/delete/renumber/rename) keep the prefix consistent: create,
    delete and renumber all renormalize their touched group folder to contiguous `[0..k]` as their
    own last file-system act (survivors keep their relative order; no persistent gaps survive a
    write), and an EditorID rename carries its own old index forward unchanged.
  - **No per-type table survives.** The plugin header used to be the exception; since #631 its body
    is the source tree's root `RecordData.json`, produced and read back through the whole-mod door
    (`Records/HeaderDocument`) because a `ModHeader` is not an `IMajorRecordGetter` and the
    per-record codec therefore cannot carry it. It is an ordinary `records` row with a view like
    every other type — its columns just sit one level deeper in the document
    (`$.ModHeader.Author`), which lives in the column's own `PropertyName`.
- **Editing is a working-tree change to text, and there is exactly one write path**
  (ADR-0041). `Edits/RecordEditService.EditField` reads the record's source file, applies the field,
  writes the file back atomically, and tells the index what landed. It reads the **file**, not the
  indexed body: the file is the bytes being edited, and reading it keeps the write path independent
  of index freshness. `POST /records/{formKey}/field` is the same service's
  HTTP door — scripts and agents (ADR-0024) share the one path, they do not get a second.
  - **Refusals are typed and happen before any write** (`RecordEditRefusal`), so a refused edit
    leaves the working tree untouched. Two of them are the untracked signposting: `PluginNotTracked`
    (a mod folder with no `.git` — one Track away) and `PluginHasNoModFolder` (a Data-directory
    master, where Track does not apply and the answer is a patch plugin). They are distinct because
    each names a different way out; naming the wrong one is worse than naming none. Over HTTP they
    travel as a ProblemDetails `refusal` extension beside the detail, so an agent branches on a
    discriminator rather than on prose.
  - **FormLinks validate at edit time**, against effective state (ADR-0041). The check is
    `CheckErrorBuilder` over the incoming value — the same builder the read model renders check
    errors from — so "what the editor flags" and "what it refuses to create" cannot drift. Scope is
    the reflected columns: every reflected FormLink shape — top-level column, struct/array
    sub-field — carries the `ApplyFormLinkJson` write delegate (`SchemaReflector`'s
    `ProjectColumn`/`ProjectSubField`) and is writable through this one door. VMAD Object
    properties and condition Form params carry FormKeys outside the reflected schema and are not
    checked here; widening that is its own change.
  - **Reads validate source freshness** (`Source/SourceFreshness`). Point
    reads re-check the source text before answering, catching `git restore`, checkout, rebase,
    terminal commits and hand edits — no watcher, because Modbench owns the `.git` folder and git
    never announces itself. **Both refs are re-derived**: after an external commit "committed"
    itself has moved, so a pass that refreshed only the working-tree side would leave Head serving
    bytes no ref holds. Cost is bounded by dirt, not by load order — git is consulted only for
    records the index already believes are dirty, so an unedited load order runs no git processes on
    the read path. **Exception:** that hash short-circuit answers nothing for an embedded
    child (a placed reference, a landscape, a navmesh, a Worldspace's top cell) — it has no file of
    its own, so its committed blob is its *owner's* whole document, and an owner-blob hash can never
    equal a hash of just the child's own bytes. Its rebaseline check skips the short-circuit
    outright and reads the owner's committed text in full (`git cat-file`) every time it runs, where
    a flat/own-file record's equivalent check is a cheap `git ls-tree` hash compare first.
- **The ref dimension has two values.** `records` holds exactly **one row per record
  copy**, and that row *is* `RecordRef.Effective`; the `ref` column says which state those bytes
  are, never which of several rows to pick. That is why every read and every generated
  `json_extract` view keeps answering Effective with no ref predicate anywhere, and why the SQL door
  (user filters, `medit.query`) sees what the editor sees — `WHERE "ref" = 'working-tree'` is how it
  asks for just the dirt. The committed bytes of a *diverged* record live in the
  `records_committed` difference table; `records_head` unions it with the rows that never diverged,
  giving Head a relation of the same shape, which is why `At(ref)` is a relation name rather than a
  second read implementation.
  - `is_winner` is **swept per ref**, never carried across them. A record the working tree deleted
    promotes the next plugin down at Effective, and the promoted row is a clean row physically
    shared with `records_head` — reusing Effective's answer reported two winners for one FormKey at
    Head. So `winners` is keyed `(record_ref, form_key)` and `records_head` joins it at Head.
  - `IRecordIndex.ApplyWorkingTreeChanges` moves Effective against a fixed baseline (null body =
    deletion; bytes equal to committed = convergence back to clean, by byte compare, never by a
    `content_hash` mismatch alone). `SetCommittedBaseline` moves the baseline itself. Neither can
    express the other. Both re-derive the record's extracted rows (`form_lookup`,
    `form_references`) through the same collectors ingest uses.
  - Reads that answer from the **extracted** tables (`Resolve`, `GetReferencedBy`, `GetPlacement`)
    answer identically at both refs, deliberately: those carry no ref dimension and track Effective,
    which is the answer their consumers want. The plugin header is no longer among them — it has a
    ref dimension like every other `records` row since #631, and since #661 it is a genuine source
    unit that can actually diverge on it: `SourceFreshness` validates it like any other record,
    `EditField` reaches it (refusing `FieldReadOnly`, since no header column has a write delegate
    yet), and `SourceIngest.ReconcileHead` carries its own header branch — needed because the
    structural Head reconcile still can't reach it (`EnumerateMajorRecords`, which a `ModHeader` is
    not in).
- **`SourceRepository.CommittedSourceHashes`/`ReadCommittedSourceText` ask what `HEAD` holds** — not
  what the working tree holds against the index, which is `WorkingTreeStatus` (as are
  `CommitPristineToMain` and the rebase verbs). The two diverge after exactly the events these
  exist for: an external commit, rebase or amend moves `HEAD` without touching a file. Hash values
  are directly comparable to `records.content_hash` with no conversion — both are git blob object
  names, which is why that column stores git's own hash.
- **The record-index seam is `IRecordReads`/`IRecordIndex`.** `PluginKey(Name, Origin)`
  is the compound identity on every seam member, ingest included — never a bare
  `(string plugin, string origin)` pair. **`IRecordIndex` does not itself carry read members**
  (#639): `At(RecordRef)` is the only way to a reads surface, so every read site names the ref it
  reads at — a consumer that reads captures one `var reads = index.At(RecordRef.Effective)` local,
  or takes an `IRecordReads` where that is all it needs.
  VMAD/condition reconstitution lives at the query-service level (`Queries/RecordDocumentCodecs`,
  operating on `RecordDocument.Body`) — rejected from the seam itself, same as raw SQL. No
  `Connection` property and no SQL crosses this seam except `SetFilter` — the concrete
  `DuckDbRecordIndex` keeps one, for white-box tests only.
- Every write backs up the target plugin first (timestamped `.bak`) — undo across relaunches depends
  on it; new write paths must not skip this.
  [ADR-0008](../docs/adr/0008-timestamped-binary-backups.md)
- Partial-success endpoints return a structured failures collection (named record, e.g.
  `LoadOrderResponse.Failures`) — never swallow a partial outcome or use stringly-typed errors;
  frontend decides surfacing. [ADR-0026](../docs/adr/0026-error-surfacing-policy.md)
- **The load order is readable while it is still being reconciled** (ADR-0035). `LoadOrderMirror`
  publishes the load order and index *before* the indexing loop, and `LoadOrder.Open` opens one
  arriving copy at a time, so each plugin's records become queryable the moment it is indexed.
  Three consequences bind new code:
  - **Anything derived from the whole plugin set must gate on `ILoadOrderMirror.Status`**, not
    compute over whatever is loaded so far. A partial set does not give a smaller answer, it gives
    a *wrong* one — `MasterResolution.Classify` over a mid-load load order reports a master that
    simply has not been opened yet as `DirectlyMissing` (`RecordQueryService.GetPlugins` gates on
    `LoadOrderState.Ready` for exactly this). `ConflictsComputed` is the same rule for winners: it
    is a separate field from `State` because ADR-0035's live mutations (reorder, enable, disable)
    will leave a Ready load order with stale winners.
  - **Everything a reader touches on `LoadOrder` is an immutable snapshot** (copy-on-write under
    `_mutation`), because readers walk those lists while the load appends to them. A plain
    `List<T>` here throws "Collection was modified" as often as a read coincides with a plugin
    landing.
  - **Never dispose the load order or index without draining the reconcile first.**
    `EnterExclusive()` cancels the in-flight reconcile *and waits for it to stop*; disposing a
    DuckDB connection while the indexing loop still holds it is a native crash, not a catchable
    exception. `Close`, `Dispose` and every reconcile go through it. A superseded reconcile leaves
    what it landed for its successor — nothing is torn down on cancel (ADR-0044).
  `PUT /load-order` stays blocking — still the completion signal, returning only after the winner
  sweep; `GET /load-order/status` reports progress alongside the in-flight PUT (200 with state
  `None` when idle, so a poller never reads an error to learn nothing is happening). A superseded
  or cancelled load answers 409, never 500.
- **`ILoadOrderMirror.RequireScope()` is the one "no load order held" gate**, replacing every
  consumer's own null-check-and-throw against the nullable `LoadOrder`/`Reads`/`Index` properties —
  `WorldspaceQueryService`, `ContainerChildQueryService` and `RecordQueryService` all call it (via
  their own thin `RequireReads`/`RequireLoadOrder` forwards), and so does `LoadOrderMirror` itself
  internally (`CreatePlugin`, `ReindexPlugin(PluginKey)`, `ApplyFilter`). Throws
  `NoLoadOrderException`, an `InvalidOperationException` subtype rather than a replacement of it,
  so it flows through `WriteEndpointMapping.NoLoadOrder` and every existing
  `catch (InvalidOperationException)` with no signature change.

## Folder structure

| Folder | Owns | Examples |
| ------ | ---- | ------- |
| `Plugins/` | The load-order mirror: which plugin copies are held, their registrations, reconcile | `LoadOrder`, `LoadOrderMirror`, `PluginMetadata`, `LoadOrderEntry`, `LoadOrderStatus` |
| `Schema/` | Static knowledge of Mutagen record types — read and write | `SchemaReflector`, `RecordTableSchema`, `ColumnSpec` |
| `Records/` | DuckDB index over documents: ingest, query, DDL + view generation | `IRecordReads`, `IRecordIndex`, `DuckDbRecordIndex` (orchestrates the internal `IndexStore` / `PluginIngest` / `WorkingTreeOverlay` collaborators; owns registration, the winner sweep, reads, container verbs and every transaction boundary), `PluginKey`, `TableDdlBuilder`, `RecordViewBuilder` |
| `Queries/` | Application-level questions about records | `RecordQueryService`, `ConflictClassifier`, `Models` (DTOs) |
| `Edits/` | The single write path: one field edit becomes a working-tree change; compile turns source text back into the binary | `RecordEditService`, `RecordFieldWriter`, `RecordEditResult`, `PluginWriter`, `PluginCompileService`, `SourceCheckout` |
| `Serialization/` | Per-record text source codec (ADR-0041) | `RecordTextCodec`, `RecordTextCodecCustomization` |
| `Source/` | The repo-layer verb surface over a mod folder's own (non-hidden) git repo, the Track gesture that populates it, read-time freshness over its text, and external-change classification/absorption (ADR-0041) | `SourceRepository`, `TrackService`, `SourceFreshness`, `ModFolders`, `GitCli`, `PristineFile`, `ContainerChildFields`, `CompileJournal`, `ExternalChangeClassifier`, `ExternalChangeDeferral` |

`MEditService.Bridge` is a separate thin assembly: the live `FileSystemWatcher`
lifecycle plus the unanswered-external-change queue, nothing else — it references only
load order/DB-free Core surfaces, enforced by `BridgeKnowsNothingOfLoadOrdersTests`.

Place code by ownership: `ColumnSpec` (`Schema/`) carries both read extractor + write Apply delegate; `PluginWriter` writes to disk, doesn't call back into the index; DTOs in `Queries/Models.cs`. Delete dead code.

## Endpoint invariant

Every endpoint needs `.Produces<T>()` (success) + `.ProducesProblem(status)` (each error) — else Swashbuckle emits `content?: never`, TS callers get `never`. No anonymous types (`new {...}`) — named record from `Queries/Models.cs`.

## Logging (Serilog → `%LOCALAPPDATA%/mEdit/logs/`)

- Endpoint catch: `_logger.LogError(ex, "...")` before `Results.Problem(ex.Message)`; never `ex.ToString()` (leaks stack trace); never return from catch unlogged.
- Best-effort catches: `_logger.LogWarning`, no silent `catch {}` — except `SchemaReflector`'s per-call property-accessor lambdas (avoid log noise).
- Structured properties: `_logger.LogInformation("Indexed {Count} records for {Plugin}", n, name)`.
- `LogInformation` for state transitions, `LogTrace` for per-record/per-column trace.
- Config loads from the binary's own directory (`ContentRootPath = AppContext.BaseDirectory` in `Program.cs`), not the launcher's cwd — the extension spawns us without one, and the default makes `appsettings.json` silently not load at all.
- Per-request logging is one summary line from `UseSerilogRequestLogging`, not ASP.NET Core's six-line pipeline (`Microsoft.AspNetCore: Warning` in `appsettings.json` silences that; the middleware writes under its own category, so the override doesn't reach it). Levels: Debug for success, Warning for 4xx, Error for 5xx/unhandled. Endpoint guards and the `RecordEditRefusal` → ProblemDetails mapping return 4xx **without logging anything themselves**, so this middleware is the only thing making a deliberate failure visible — don't drop or reflag it without replacing that.
