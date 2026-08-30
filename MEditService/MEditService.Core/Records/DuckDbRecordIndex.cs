using System.Data;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

// #421: the record index — the single DuckDB implementation of IRecordIndex/IRecordReads.
// IRecordRepository/IRecordReader/IRecordIndexer (the pre-#421 seam this class also implemented
// during the migration) are demolished; several former interface members below survive as private
// helpers because a PluginKey-keyed public method still delegates to them.
public sealed class DuckDbRecordIndex : IRecordIndex
{
    private readonly ISchemaReflector _schemaReflector;
    private readonly ITableDdlBuilder _ddlBuilder;
    private readonly ILogger _logger;
    private IReadOnlyDictionary<string, RecordTableSchema>? _schemas;
    private readonly PlacementWalker _placementWalker = new();
    private static readonly string[] PlacedTableNames = ["refr", "achr"];
    private bool _filterActive;
    // #165: resolved once at Initialize (this repository is one game/load order for its whole
    // lifetime) so GetConditions can decode a Number-category parameter's enum member name without
    // re-resolving per call. Null for a game with no condition codec — same "fails to nothing, not
    // silently wrong" fallback ConditionCodecRegistry.For already establishes elsewhere.
    private IConditionCodec? _conditionCodec;

    // ADR-0041 / #413: the per-record source codec, which is now the ingest path for every record —
    // each document body is exactly the bytes the record's source file holds. Constructed here
    // rather than injected: it is stateless apart from its own reflection caches (which are static),
    // and every existing construction site of this repository would otherwise have to learn about a
    // dependency it has no say in.
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    /// <summary>#585: the file-mirror table, named once so the writes, the open-time validation
    /// and the version check cannot drift onto different spellings of it.</summary>
    private const string FilesRelation = "mirror.files";

    public DuckDBConnection Connection { get; private set; }

    // #585 / ADR-0001: where this index lives, or null for an index with no home on disk — the
    // in-memory shape every construction site had before this ticket, kept because it is a real
    // mode (a caller with no game install to key a file by) and because the suite's several hundred
    // index fixtures have no business writing to the user's local app data.
    private readonly string? _databasePath;

    // The version the rows in this file were written under (IndexVersion), resolved at Initialize
    // once the game release is known.
    private string? _indexVersion;

    public DuckDbRecordIndex(
        ISchemaReflector schemaReflector,
        ITableDdlBuilder ddlBuilder,
        ILogger logger,
        string? databasePath = null)
    {
        _schemaReflector = schemaReflector;
        _ddlBuilder = ddlBuilder;
        _logger = logger;
        _databasePath = databasePath;
        Connection = Open();
    }

    /// <summary>
    /// Opens the index, rebuilding it from scratch if the file cannot be opened at all — a DuckDB
    /// storage-format change on upgrade, or a truncated/corrupt file (ADR-0001 point 6). The index
    /// is derived state and losing it costs one cold load, which is what a load costs today anyway,
    /// so a rebuild is strictly better than refusing to start.
    /// </summary>
    private DuckDBConnection Open()
    {
        if (_databasePath == null)
        {
            var memory = new DuckDBConnection("DataSource=:memory:");
            memory.Open();
            return memory;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(_databasePath)!);
        try
        {
            return OpenFile();
        }
        catch (Exception ex) when (IsAnotherWriter(ex))
        {
            throw IndexHeldElsewhereException.For(_databasePath, ex);
        }
        catch (Exception ex)
        {
            // Deliberately every other exception rather than DuckDBException alone: what a file
            // DuckDB cannot make sense of throws is its own business and has changed between
            // versions, and the answer here — throw the file away and start again — is the same for
            // all of them. The index is derived state; losing it costs one cold load.
            _logger.LogWarning(ex, "Could not open the index at {Path}; rebuilding it from scratch", _databasePath);
            File.Delete(_databasePath);
            return OpenFile();
        }
    }

    /// <summary>
    /// Whether this open failed because <b>another process already holds the file</b> — a second
    /// Modbench window on the same game (ADR-0001 point 6), which is a different failure from a
    /// corrupt one and must never be answered by rebuilding: deleting a file another process has
    /// open succeeds on POSIX and destroys that window's live index, which is precisely the "silent
    /// divergence" the decision rejects. Such an open throws <see cref="IndexHeldElsewhereException"/>
    /// naming the file instead (#588), which <c>PUT /load-order</c> answers 423 Locked.
    ///
    /// <para>Matched on DuckDB's own message because that is the only thing it offers — the lock
    /// conflict and a corrupt file arrive as the same exception type. Both platforms' wordings share
    /// DuckDB's own prefix, and an unrecognised wording degrades to the rebuild branch, so this is a
    /// guard against the known case rather than a claim to have enumerated every one.</para>
    /// </summary>
    internal static bool IsAnotherWriter(Exception ex) =>
        ex.Message.Contains("lock on file", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("Conflicting lock", StringComparison.OrdinalIgnoreCase);

    private DuckDBConnection OpenFile()
    {
        var connection = new DuckDBConnection($"DataSource={_databasePath}");
        connection.Open();
        return connection;
    }

    // Retained for the reconstitution path (#413 D1): reading a record back out of its document
    // needs the release it was written under, and this repository is one game for its whole
    // lifetime — the same reasoning that already resolves _conditionCodec once, here.
    private GameRelease _release;

    public void Initialize(GameRelease release)
    {
        _indexVersion = IndexVersion.For(_schemaReflector, release);
        // Before the DDL, not after: `CREATE TABLE IF NOT EXISTS` leaves an existing file's old
        // column lists exactly as they are, so a file written under a different shape has to be
        // thrown away *before* this process starts appending to tables it only half recognizes.
        DiscardFileWrittenUnderAnotherVersion();

        _ddlBuilder.CreateTables(Connection, release);
        _schemas = _schemaReflector.GetSchemas(release);
        _conditionCodec = ConditionCodecRegistry.For(release.ToCategory());
        _release = release;

        ValidateAgainstDisk();
    }

    /// <summary>
    /// #585 / ADR-0001: a codec or schema version change invalidates the <b>whole</b> file. There is
    /// no partial answer — the stored documents are the codec's output and the generated views are
    /// the reflector's, so a file written under another version describes a read model this process
    /// does not have — and no in-place migration either, which is what "rebuilt from scratch" means:
    /// the file is deleted and reopened empty, costing exactly one cold load.
    /// </summary>
    private void DiscardFileWrittenUnderAnotherVersion()
    {
        if (_databasePath == null) return;

        List<string> versions;
        try
        {
            // Asked of the catalog first, so that "this file has never been written to" — the
            // ordinary first open, where the table simply does not exist yet — is an answer rather
            // than an exception. That separation is what lets the catch below mean something: past
            // this point, a file that cannot answer is a file this process cannot reason about, and
            // the safe reading of an unreadable mirror is that it is stale.
            if (!IndexedFilesTableExists()) return;

            versions = [];
            using var cmd = Connection.CreateCommand();
            cmd.CommandText = $"SELECT DISTINCT index_version FROM {FilesRelation}";
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) versions.Add(reader.GetString(0));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _logger.LogWarning(ex,
                "Could not read the index version at {Path}; rebuilding it from scratch", _databasePath);
            RebuildFile();
            return;
        }

        if (versions.Count == 0 || versions.All(v => v == _indexVersion)) return;

        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation(
                "The index at {Path} was written under a different codec/schema version; rebuilding it from scratch",
                _databasePath);
        }
        RebuildFile();
    }

    private bool IndexedFilesTableExists()
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText =
            "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'mirror' AND table_name = 'files'";
        return Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) > 0;
    }

    /// <summary>Throws the file away and opens an empty one in its place. Only reachable once the
    /// file has already been opened successfully, so it can never race the second-writer case
    /// <see cref="IsAnotherWriter"/> guards.</summary>
    private void RebuildFile()
    {
        Connection.Dispose();
        File.Delete(_databasePath!);
        Connection = OpenFile();
    }

    /// <summary>
    /// #585 / ADR-0001: validity is by content, never by clock. Every plugin the file holds rows for
    /// is checked against the file those rows were built from — gone means <see cref="Unindex"/>,
    /// different bytes means <see cref="Unindex"/> too, so the next load re-indexes it in place and
    /// no read can ever answer from rows the disk no longer backs. A hash, never an <c>mtime</c>:
    /// MO2, xEdit, Steam and the user all write these files and a preserved timestamp is free.
    ///
    /// <para>Registrations are <i>not</i> cleared (ADR-0001 point 4, amended by ADR-0044): the
    /// <c>registrations</c> rows are the last known load order, and the first reconcile corrects
    /// them — which is what lets a restart followed by an identical snapshot cost nothing.</para>
    /// </summary>
    private void ValidateAgainstDisk()
    {
        if (_databasePath == null) return;

        var timer = Stopwatch.StartNew();
        var checkedCount = 0;
        foreach (var (key, filePath, contentHash) in IndexedFiles())
        {
            checkedCount++;
            if (!File.Exists(filePath))
            {
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation(
                        "{Plugin} ({Origin}) is no longer on disk at {Path}; removing its rows",
                        key.Name, key.Origin, filePath);
                }
                Unindex(key);
                continue;
            }

            if (FileContentHash(filePath) is not { } observed || observed != contentHash)
            {
                if (_logger.IsEnabled(LogLevel.Information))
                {
                    _logger.LogInformation(
                        "{Plugin} ({Origin}) changed on disk since it was indexed; removing its rows so it is re-indexed",
                        key.Name, key.Origin);
                }
                Unindex(key);
            }
        }

        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Validated {Count} indexed plugin(s) against disk in {ElapsedMs} ms",
                checkedCount, timer.ElapsedMilliseconds);
        }
    }

    private List<(PluginKey Key, string FilePath, string ContentHash)> IndexedFiles()
    {
        var rows = new List<(PluginKey Key, string FilePath, string ContentHash)>();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin, file_path, content_hash FROM {FilesRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            rows.Add((new PluginKey(reader.GetString(0), reader.GetString(1)), reader.GetString(2), reader.GetString(3)));
        return rows;
    }

    /// <summary>The content hash of one plugin file, or <see langword="null"/> when it cannot be
    /// read at all — a file another process is mid-write on, or one whose permissions changed. Null
    /// counts as a mismatch at <see cref="ValidateAgainstDisk"/>: an unreadable file is not evidence
    /// that the rows built from it are still true. Shared with the runtime mirror
    /// (<see cref="PluginBinaryHash"/>), which has to produce the identical string for the identical
    /// bytes or a real change would read as a touch.</summary>
    private string? FileContentHash(string filePath)
    {
        var hash = PluginBinaryHash.OfFile(filePath);
        if (hash == null && _logger.IsEnabled(LogLevel.Warning))
        {
            _logger.LogWarning("Could not read {Path} to hash it; treating the index's rows for it as stale", filePath);
        }
        return hash;
    }

    // --- Indexing (absorbed from RecordIndexer) ---

    public void Index(IModGetter plugin, Registration registration, PluginKey key, string? filePath = null) =>
        Index(plugin, registration, key.Origin!, filePath);

    /// <summary>See <see cref="IRecordIndex.IndexedContentHash"/>.</summary>
    public string? IndexedContentHash(PluginKey key) =>
        ScalarString(
            $"SELECT content_hash FROM {FilesRelation} WHERE plugin = $1 AND origin = $2",
            key.Name, key.Origin!);

    // #585 / ADR-0001: the file half of an Index() call — what was on disk, and what shape its rows
    // were written in. Inside Index()'s own transaction, so a re-index that throws partway leaves
    // neither the rows nor the claim about them behind. A caller that names no file (an in-memory
    // mod, which is every fixture in the suite and the New Plugin gesture's freshly written one
    // before it has a stamp worth taking) writes no row: the index then holds those rows without
    // claiming any disk file backs them, which is exactly true, and the next load re-indexes.
    private void StampIndexedFile(string plugin, string origin, string? filePath)
    {
        DeleteIndexedFile(plugin, origin);
        if (filePath == null || FileContentHash(filePath) is not { } contentHash) return;

        ExecuteFor($"""
            INSERT INTO {FilesRelation} (plugin, origin, file_path, content_hash, index_version)
            VALUES ($1, $2, $3, $4, $5)
            """, plugin, origin, Path.GetFullPath(filePath), contentHash, _indexVersion!);
    }

    // origin (#271 / ADR-0036): the mod folder that provided this physical file, or a reserved
    // PluginOrigin value. Required (#275) — threaded into every per-plugin delete/upsert/append
    // below so a plugin is identified by (origin, plugin) together, not filename alone: two
    // plugins sharing a filename but differing in origin no longer collide.
    //
    // #421: private — Index(PluginKey) above is the public seam member and delegates here.
    private void Index(IModGetter pluginMod, Registration registration, string origin, string? filePath)
    {
        var schemas = RequireSchemas();
        var plugin = pluginMod.ModKey.FileName.ToString();

        var refs = new List<FormRef>();
        var lookupRows = new List<(string FormKey, string RecordType, string? EditorId)>();
        var containerChildRows = new List<ContainerChildRow>();

        // One transaction for the whole reindex so a throw partway leaves the prior committed
        // read model intact rather than a partial snapshot. DuckDB appenders enroll in the active
        // transaction, so deletes and appender flushes roll back together on Dispose-without-Commit.
        using var tx = Connection.BeginTransaction();

        // #267: one `registrations` row per indexed plugin — UpdateWinners() joins against it so a
        // non-participating copy's rows never win regardless of load_order_idx.
        UpsertRegistration(plugin, origin, registration);
        // #585: and the disk claim these rows are about, replaced with them rather than beside them.
        StampIndexedFile(plugin, origin, filePath);

        // ADR-0041 / #413: this plugin's documents go first, for the same reason every other table's
        // delete does — a re-index replaces its own rows rather than accumulating a second copy.
        // The header is deliberately absent from `records`: a ModHeader is not an IMajorRecordGetter,
        // so it has no codec document at all, and stays a purely extracted index table (D8).
        DeleteExistingForOrigin("records", plugin, origin);
        // #452: and the Head snapshots with them. `records_head` is records_committed UNION ALL the
        // still-clean `records` rows, and those halves must stay disjoint (TableDdlBuilder says so "by
        // construction" and its UNION ALL — not UNION — depends on it exactly). Re-seeding `records`
        // while leaving a snapshot behind puts two rows under one (form_key, plugin, origin) at Head.
        //
        // This is a genuine part of Index()'s own stated contract — "replacing whatever `key`
        // previously held" — that was simply never reachable before: nothing used to call Index() and
        // write records_committed for the same key in one operation, with a failure path that calls
        // Index() on that key again. SourceIngest.Ingest is the first (its binary fallback), and
        // LoadOrderMirror.ReindexPlugin re-reading a binary under a dirty tracked plugin is a second.
        // Fixing it here rather than at either call site is what makes every present and future caller
        // inherit it. Never removes a *correct* snapshot: after a full re-index from one source, a
        // prior divergence describes bytes that no longer relate to what was just ingested.
        DeleteExistingForOrigin("records_committed", plugin, origin);
        using var documentAppender = Connection.CreateAppender("mirror", "records");

        if (_conditionCodec == null)
        {
            _logger.LogWarning("No condition codec for {Game}; skipping condition refs for {Plugin}",
                pluginMod.GameRelease, plugin);
        }

        var phaseTimer = Stopwatch.StartNew();
        var counters = new RefCounters();
        foreach (var (tableName, schema) in schemas)
        {
            // The header table is never a major-record type (ModHeader has no FormKey/EditorID) —
            // IndexRecordTable's EnumerateMajorRecords call assumes one, so it's indexed separately,
            // and header rows never enter form_lookup for the same reason.
            if (tableName == "header") continue;
            IndexRecordTable(
                tableName, schema, pluginMod, plugin, origin, refs, lookupRows,
                containerChildRows, documentAppender, pluginMod.GameRelease, counters);
        }
        var documentsMs = phaseTimer.ElapsedMilliseconds;

        // #217: same summary texts/levels as before (RecordIndexingLoggingTests pins them), now
        // counted from the one pass above rather than from two further walks of the plugin.
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Indexed VMAD for {Count} records in {Plugin}", counters.Vmad, plugin);
            _logger.LogDebug("Indexed conditions for {Count} records in {Plugin}", counters.Conditions, plugin);
        }

        // Walk VMAD after the per-type loop so both generic and VMAD Object refs land in `refs`
        // before the single form_references flush below.
        // #272 / ADR-0036: VMAD/conditions/form_lookup/header now all carry origin too, scoped the
        // same way as every other table above — closes the gap #271 left open. Header's own delete
        // step is in IndexHeader below; its write side already carried origin since #271.
        //
        // #420: VMAD and conditions no longer have their own side tables to delete-then-append —
        // both collect straight into the shared `refs` list below, walking the live object (already
        // in hand here) rather than round-tripping through the document this same pass just wrote.
        // GetVmad/GetConditions read the document instead, on demand (#413 D1's pattern).
        // #113: VMAD and condition refs are collected inside IndexRecordTable's one pass now. The
        // two whole-plugin walks that used to run here (a typed VMAD enumeration, then a second
        // EnumerateMajorRecords() with a linear type scan per record) were 29% of a full load
        // order's index time. What that pass does not see is exactly what has no schema
        // (SchemaReflector.ExcludedTables — the placed projectile types): those records have no
        // document and no row, and now contribute no VMAD/condition refs either, where before they
        // contributed refs from a record the index could not otherwise show.

        phaseTimer.Restart();
        IndexPlacement(pluginMod, plugin, origin);

        IndexHeader(pluginMod, plugin, origin, schemas);

        // Clear this plugin's stale refs, then rebuild from the refs gathered across both passes.
        DeleteFormReferencesForPlugin(plugin, origin);
        if (refs.Count > 0)
        {
            using var refAppender = Connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                AppendFormReference(refAppender, r, plugin, origin);
        }

        // ADR-0031: one form_lookup row per indexed record, populated in this same pass — no
        // second indexing pass over the plugin.
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        if (lookupRows.Count > 0)
        {
            using var lookupAppender = Connection.CreateAppender("mirror", "form_lookup");
            foreach (var (formKey, recordType, editorId) in lookupRows)
            {
                var row = lookupAppender.CreateRow();
                row.AppendValue(formKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                row.AppendValue(recordType);
                if (editorId is { } eid)
                    row.AppendValue(eid);
                else
                    row.AppendNullValue();
                row.EndRow();
            }
        }

        // #416 S1b: same pattern as form_lookup just above — one delete-then-append per re-index,
        // populated from the same per-type pass rather than a second walk over the plugin.
        DeleteExistingForOrigin("container_child", plugin, origin);
        if (containerChildRows.Count > 0)
        {
            using var containerChildAppender = Connection.CreateAppender("mirror", "container_child");
            foreach (var row in containerChildRows)
            {
                var r = containerChildAppender.CreateRow();
                r.AppendValue(row.ChildFormKey);
                r.AppendValue(plugin);
                r.AppendValue(origin);
                r.AppendValue(row.ParentFormKey);
                r.AppendValue(row.ParentRecordType);
                r.AppendValue(row.SlotName);
                r.AppendValue(row.SlotIndex);
                r.EndRow();
            }
        }

        var extractedMs = phaseTimer.ElapsedMilliseconds;
        phaseTimer.Restart();
        tx.Commit();
        // #113: per-phase load timing — "documents" spans record enumeration plus every per-record
        // cost (serialize, hash, form/VMAD/condition refs, container children, append); "extracted"
        // spans placement/header and the form_references/form_lookup/container_child flushes.
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug(
                "Index {Plugin}: documents {DocumentsMs} ms (prepare {PrepareMs} ms, append {AppendMs} ms), extracted tables {ExtractedMs} ms, commit {CommitMs} ms",
                plugin, documentsMs, counters.PrepareMs, counters.AppendMs, extractedMs, phaseTimer.ElapsedMilliseconds);
        }
    }

    public void Unindex(PluginKey key) => Unindex(key.Name, key.Origin!);

    // The inverse of Index, table for table — same transaction discipline, and deliberately built
    // from the same per-plugin delete helpers Index itself calls before each append, so a new
    // indexed table cannot be added to one side without the other noticing (they are the same
    // calls). The `registrations` row is dropped last: it is the row UpdateWinners joins against, and while
    // it exists this (origin, plugin) is still a known member of the read model.
    //
    // #421: private — Unindex(PluginKey) above is the public seam member and delegates here.
    private void Unindex(string plugin, string origin)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unindexing {Plugin} from {Origin}", plugin, origin);
        }
        using var tx = Connection.BeginTransaction();

        // #413: one delete where this used to walk every reflected table — the record rows are all
        // in `records` now, and the only surviving per-type table is the header, deleted just below.
        // #420: VMAD and conditions have no side tables of their own any more — deleting this
        // plugin's `records` rows above already removes the one thing GetVmad/GetConditions read.
        DeleteExistingForOrigin("records", plugin, origin);
        // #452: "removes every trace of key" has to include the Head side. A leftover snapshot would
        // keep answering at Head for a plugin the load order no longer holds — the exact opposite of
        // #34/ADR-0035's "hidden means absent".
        DeleteExistingForOrigin("records_committed", plugin, origin);
        DeleteExistingForOrigin("header", plugin, origin);
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        DeleteFormReferencesForPlugin(plugin, origin);
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);
        DeleteExistingForOrigin("container_child", plugin, origin);
        // #585: the file claim goes with the rows it describes — Unindex is the file-gone verb, so
        // leaving it behind would leave the mirror asserting rows the index no longer holds.
        DeleteIndexedFile(plugin, origin);
        DeleteRegistration(plugin, origin);

        tx.Commit();
    }

    // ADR-0041 / #413: one document per major record, written from the same enumeration that fills
    // the record's own row — never a second pass over the plugin. The appender is opened once per
    // Index() call and threaded through the per-type loop below, because `records` is one table
    // spanning every type where the wide tables were one appender each.
    //
    // Blocking on the codec's async path is deliberate rather than an oversight: serialization runs
    // entirely over a MemoryStream with no IO (RecordTextCodec.SerializeToBytesAsync), so there is
    // nothing to await on. The async signature comes from Mutagen's generated serializers, and
    // making Index() async to match would push a false IO-bound shape up through IRecordIndex into
    // LoadOrderMirror's indexing loop for no benefit.
    // #416 S1b: Cell.Persistent/Temporary and Worldspace.TopCell/SubCells are already fully covered
    // by IndexPlacement (placement/cell_location) — this skip-list keeps container_child additive to
    // those tables rather than a second, competing copy of the same relationship. Keyed by
    // ContainerChildFields.NormalizedTypeName so it can never drift from what EnumerateChildren
    // itself walks (both read the same ByTypeName table).
    private static readonly HashSet<(string ParentType, string Slot)> CoveredByPlacementTables =
    [
        ("Cell", "Persistent"), ("Cell", "Temporary"),
        ("Worldspace", "TopCell"), ("Worldspace", "SubCells"),
    ];

    /// <summary>Everything about one record that the index derives from the record itself, computed
    /// off the appender thread (#113): the document bytes and their git-blob hash, the extracted
    /// form/VMAD/condition refs, and the container-child slots. Only writing it is sequential.</summary>
    private sealed record PreparedRecord(
        IMajorRecordGetter Record, byte[] Body, string ContentHash, List<FormRef> Refs,
        List<ContainerChildRow> ChildRows, bool HasVmad, bool HasConditions);

    private sealed class RefCounters
    {
        public int Vmad;
        public int Conditions;
        public long PrepareMs;
        public long AppendMs;
    }

    private PreparedRecord PrepareRecord(
        IMajorRecordGetter record, string recordType, RecordTableSchema schema, GameRelease gameRelease)
    {
        // #416 S1b: a container's children get a recorded parent slot, for the relationships
        // placement/cell_location don't already carry. Read off the same record about to be
        // serialized, so what is remembered and what is stored cannot describe different graphs.
        var childRows = new List<ContainerChildRow>();
        var parentType = ContainerChildFields.NormalizedTypeName(record.GetType());
        foreach (var (slotName, slotIndex, child) in ContainerChildFields.EnumerateChildren(record))
        {
            if (CoveredByPlacementTables.Contains((parentType, slotName))) continue;
            childRows.Add(new ContainerChildRow(
                child.FormKey.ToString(), record.FormKey.ToString(), recordType, slotName, slotIndex));
        }

        var refs = new List<FormRef>();
        CollectFormRefs(refs, record, recordType, schema);

        // Same per-record NotImplementedException guard the old whole-plugin VMAD walk had: a live
        // binary-overlay accessor for a not-yet-implemented property type can still throw here.
        var hasVmad = false;
        if (record is IHaveVirtualMachineAdapterGetter { VirtualMachineAdapter: not null })
        {
            try
            {
                CollectVmadRefsForRecord(record, recordType, refs);
                hasVmad = true;
            }
            catch (NotImplementedException ex)
            {
                _logger.LogWarning(ex,
                    "Skipping VMAD for {FormKey} — property type not implemented in Mutagen",
                    record.FormKey);
            }
        }
        var hasConditions = CollectConditionRefsForRecord(record, recordType, refs);

        // #450 retires #413 D8's deep-copy-and-strip: every record is serialized straight from the
        // getter ingest already holds, container or not. A container's document now carries the
        // children Spriggit embeds, because that is what its source file holds — the whole point of
        // one document shape (ADR-0041's #444 amendment). The deep copy that made stripping possible
        // was the only per-container cost on this path (~5% of a real corpus) and goes with it.
        //
        // The divergence window this used to warn about is closed. #452 made a tracked plugin ingest
        // from its source tree, where an embedded child has no separate file to diverge from, and #454
        // retired ContainerAssembler along with the last consumer that could have read a stale inline
        // copy — compile now deserializes the tree whole, so a container's children come from the one
        // document that holds them. Do not reopen it with a reconciliation pass; that is the shape
        // ADR-0041's amendment exists to delete.
        var body = _codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult();
        // Hashed from the codec's own bytes rather than from a string: identical for the valid
        // UTF-8 the codec emits, but this keeps the hash defined by what the source file would
        // contain, not by a round trip through .NET's string encoder.
        return new PreparedRecord(record, body, GitBlobHash.Of(body), refs, childRows, hasVmad, hasConditions);
    }

    private static void AppendPrepared(
        DuckDBAppender documentAppender, PreparedRecord prepared, string recordType,
        string plugin, string origin)
    {
        var record = prepared.Record;
        var row = documentAppender.CreateRow();
        row.AppendValue(record.FormKey.ToString());
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(recordType);
        if (record.EditorID is { } editorId)
            row.AppendValue(editorId);
        else
            row.AppendNullValue();
        row.AppendValue(SourceRef.Committed);
        row.AppendValue(Encoding.UTF8.GetString(prepared.Body));
        row.AppendValue(prepared.ContentHash);
        row.EndRow();
    }

    private void IndexRecordTable(
        string tableName, RecordTableSchema schema, IModGetter pluginMod,
        string plugin, string origin, List<FormRef> refs,
        List<(string FormKey, string RecordType, string? EditorId)> lookupRows,
        List<ContainerChildRow> containerChildRows,
        DuckDBAppender documentAppender, GameRelease gameRelease, RefCounters counters)
    {
        List<IMajorRecordGetter> records;
        try
        {
            records = [.. pluginMod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false)];
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to enumerate {RecordType} records from {Plugin}", tableName, plugin);
            throw;
        }

        if (records.Count == 0) return;

        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Appending {Count} {RecordType} records from {Plugin}", records.Count, tableName, plugin);
        }

        // ADR-0041 / #413: no per-type table to delete from or append to any more. This loop's whole
        // output is now one document per record plus the extracted index rows derived from it — the
        // per-type enumeration survives only because it is how a record's type is known.
        //
        // #113: the per-record work is CPU-bound and independent record to record — serialize,
        // hash, the form-ref walk, container children, VMAD and condition refs — and was 98% of a
        // full load order's load on one core of eight. It runs in parallel here; only the appender
        // writes stay sequential, in enumeration order (AsOrdered), so a re-index lands rows in the
        // same order it always did. The codec and the collectors hold no per-call mutable state
        // (RecordTextCodec's caches are ConcurrentDictionaries; Mutagen's binary overlays are
        // immutable views), and a serialize under parallelism was verified byte-identical to the
        // sequential one (pinned by ParallelPrepareParityTests). A throw from any record surfaces
        // as the original exception, not as an AggregateException: every failing record has
        // already been logged individually by PrepareRecordLogged, so when several fail in one
        // batch the first is the one rethrown and the rest are in the log.
        // Bounded batches rather than one parallel pass over the whole type: a 1.55M-record master
        // has single types in the hundreds of thousands, and preparing all of them before appending
        // any held every body and ref list live at once — measured as ~100 s of GC on Fallout4.esm,
        // more than the serialize it was overlapping. A batch's worth is what is ever in flight.
        foreach (var batch in records.Chunk(PrepareBatchSize))
        {
            List<PreparedRecord> prepared;
            var batchTimer = Stopwatch.StartNew();
            try
            {
                prepared = batch
                    .AsParallel().AsOrdered()
                    .Select(record => PrepareRecordLogged(record, tableName, schema, plugin, gameRelease))
                    .ToList();
            }
            catch (AggregateException ex) when (ex.InnerExceptions.Count > 0)
            {
                ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
                throw;
            }
            counters.PrepareMs += batchTimer.ElapsedMilliseconds;
            batchTimer.Restart();

            foreach (var p in prepared)
            {
                var record = p.Record;
                try
                {
                    AppendPrepared(documentAppender, p, tableName, plugin, origin);
                }
                catch (Exception ex)
                {
                    _logger.LogError(ex,
                        "Failed to append {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                        tableName, record.FormKey, record.EditorID, plugin);
                    throw;
                }
                refs.AddRange(p.Refs);
                containerChildRows.AddRange(p.ChildRows);
                lookupRows.Add((record.FormKey.ToString(), tableName, record.EditorID));
                if (p.HasVmad) counters.Vmad++;
                if (p.HasConditions) counters.Conditions++;
                if (_logger.IsEnabled(LogLevel.Trace))
                {
                    // #217: same per-record trace texts as before (RecordIndexingLoggingTests pins them).
                    _logger.LogTrace("Appended {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                        tableName, record.FormKey, record.EditorID, plugin);
                    if (p.HasVmad)
                    {
                        _logger.LogTrace("Indexed VMAD for {FormKey} ({RecordType}) in {Plugin}",
                            record.FormKey, tableName, plugin);
                    }
                    if (p.HasConditions)
                    {
                        _logger.LogTrace("Indexed conditions for {FormKey} ({RecordType}) in {Plugin}",
                            record.FormKey, tableName, plugin);
                    }
                }
            }
            counters.AppendMs += batchTimer.ElapsedMilliseconds;
        }
    }

    /// <summary>Records prepared in parallel ahead of the appender at a time (#113). Large enough
    /// to keep eight cores busy on cheap records; small enough that a batch of the largest cell
    /// documents stays well inside a few hundred MB.</summary>
    private const int PrepareBatchSize = 2048;

    private PreparedRecord PrepareRecordLogged(
        IMajorRecordGetter record, string tableName, RecordTableSchema schema, string plugin, GameRelease gameRelease)
    {
        try
        {
            return PrepareRecord(record, tableName, schema, gameRelease);
        }
        catch (Exception ex)
        {
            // Its own message, not AppendPrepared's: nothing has been appended when this fires —
            // the serialize, hash, ref walk or child enumeration failed for this record.
            _logger.LogError(ex,
                "Failed to prepare {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                tableName, record.FormKey, record.EditorID, plugin);
            throw;
        }
    }

    // #267 / ADR-0035: one row per registered copy, upserted by every Index() and Register() call.
    // UpdateWinners() joins `records` against it rather than carrying a participates column per row
    // — and since ADR-0044 not even this row carries one: participation is derived from the three
    // facts stored here (TableDdlBuilder.ParticipatesPredicate).
    private void UpsertRegistration(string plugin, string origin, Registration registration)
    {
        DeleteRegistration(plugin, origin);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"INSERT INTO {TableDdlBuilder.RegistrationsRelation} (plugin, origin, load_order_idx, enabled, winning) VALUES ($1, $2, $3, $4, $5)";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.Parameters.Add(new DuckDBParameter { Value = (object?)registration.LoadOrderIndex ?? DBNull.Value });
        cmd.Parameters.Add(new DuckDBParameter { Value = registration.Enabled });
        cmd.Parameters.Add(new DuckDBParameter { Value = registration.Winning });
        cmd.ExecuteNonQuery();
    }

    // #582 / ADR-0001: registration is visibility. The `registrations` row is the whole of a
    // copy's membership in the load order — every public relation (`records`, the extracted tables,
    // every generated per-type view) is a view over its `mirror.` table joined to this row (see
    // TableDdlBuilder.CreateRegisteredViews for the one predicate they all share), so writing or
    // deleting the row is what makes a plugin's rows answer or fall silent. Neither verb touches a
    // data row: Register after Unregister answers again with no re-index, and Unregister leaves
    // Index()'s work intact for the next load order that wants it. Unindex is the file-gone verb.
    public void Register(PluginKey key, Registration registration) =>
        UpsertRegistration(key.Name, key.Origin!, registration);

    public void Unregister(PluginKey key)
    {
        if (_logger.IsEnabled(LogLevel.Information))
        {
            _logger.LogInformation("Unregistering {Plugin} from {Origin}", key.Name, key.Origin);
        }
        DeleteRegistration(key.Name, key.Origin!);
    }

    /// <summary>See <see cref="IRecordIndex.RegisteredPlugins"/>.</summary>
    public IReadOnlyList<PluginKey> RegisteredPlugins()
    {
        var keys = new List<PluginKey>();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT plugin, origin FROM {TableDdlBuilder.RegistrationsRelation}";
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
            keys.Add(new PluginKey(reader.GetString(0), reader.GetString(1)));
        return keys;
    }

    private void DeleteRegistration(string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    /// <summary>See <see cref="IRecordIndex.UpdateWinners"/>.</summary>
    ///
    /// <remarks>
    /// #584 / ADR-0001: winning is a function of the registered load order alone, so it lives in
    /// <c>winners</c> — one row per (ref, FormKey) naming the plugin whose copy wins — and is
    /// rebuilt wholesale here rather than UPDATEd onto a column of three separate data tables. The
    /// readers never name this table: the registered views and <c>records_head</c> join it to project
    /// <c>is_winner</c>, so the projection is written once (<c>TableDdlBuilder</c>) and the rule once
    /// (here), instead of once per relation in each place.
    ///
    /// <para>#271 / ADR-0036: partitioned on (plugin, origin) together — two plugins sharing a
    /// filename but differing in origin are distinct participants, each judged on its own
    /// load_order_idx and participation, not folded into one bucket by filename alone. #583 /
    /// ADR-0001: that load_order_idx is read from the <c>registrations</c> row the participation
    /// join already needs, never from the record row. ADR-0044: participation itself is derived
    /// there too (<see cref="TableDdlBuilder.ParticipatesPredicate"/>) — a losing copy and a
    /// disabled line are both registered and both excluded here by the same predicate.</para>
    ///
    /// <para>Wholesale rather than incremental because there is no smaller correct unit: registering
    /// a plugin at a new index can move the winner of every FormKey it holds. #427 measured the
    /// whole-load-order sweep over a 48,000-record, 60-plugin fixture — larger than the overwhelming
    /// majority of real load orders — and #584 re-measured the same shape at parity with the
    /// three-table UPDATE it replaces (~75ms for both refs against ~37ms per fat table swept), with
    /// the winner-filtered reads unchanged: the registered view's <c>registrations</c> join already
    /// dominates them, and joining <c>winners</c> beside it costs nothing measurable.</para>
    /// </remarks>
    public void UpdateWinners()
    {
        Execute($"DELETE FROM {TableDdlBuilder.WinnersRelation}");

        // Effective. The header table is swept in the same statement rather than in one of its own:
        // it is the only surviving per-type table (D8, #413) and would otherwise never have a winner
        // at all — which reads as "no header exists" through every winnerOnly lookup, Open Header
        // included — and its FormKeys cannot collide with a record's, since HeaderIndexer.FormKeyFor
        // mints them at FormID 000000, the null form, which no major record can occupy.
        //
        // form_lookup gets no branch here at all: ADR-0031 keeps exactly one lookup row per Effective
        // record row (ingest appends them together, RederiveIndexRowsForRecord and
        // DeleteDerivationsForRecord keep them in step), so `records`' own winners *are*
        // form_lookup's, and its registered view joins the same rows. That is what makes
        // ResolveFormKey's EditorID reflect the winning override by construction rather than by a
        // second sweep that could drift from this one.
        InsertWinners(RecordRef.Effective, $"""
            SELECT form_key, plugin, origin FROM mirror.records
            UNION ALL
            SELECT form_key, plugin, origin FROM mirror."{HeaderIndexer.TableName}"
            """);

        // Head, over the same membership relation records_head itself is built on. A record the
        // working tree deleted is gone from Effective but still held at Head, so the two stacks can
        // name different winners for one FormKey — see TableDdlBuilder.CreateHeadView.
        InsertWinners(RecordRef.Head, $"SELECT form_key, plugin, origin FROM {TableDdlBuilder.HeadRowsRelation}");
    }

    // The winner rule itself, once: among the rows <paramref name="rowsSql"/> yields, the one whose
    // plugin is registered, participating, and latest in the load order wins its FormKey. QUALIFY
    // (rather than the MAX() compare this replaces) is what makes the result a function — a tie on
    // load_order_idx yields one winner, not two — and the (plugin, origin) tiebreak makes which one
    // deterministic rather than dependent on scan order.
    private void InsertWinners(RecordRef @ref, string rowsSql) =>
        Execute($"""
            INSERT INTO {TableDdlBuilder.WinnersRelation} (record_ref, form_key, plugin, origin)
            SELECT '{WinnerRef.Of(@ref)}', r.form_key, r.plugin, r.origin
            FROM ({rowsSql}) r
            JOIN {TableDdlBuilder.RegistrationsRelation} p
              ON p.plugin = r.plugin AND p.origin = r.origin AND {TableDdlBuilder.ParticipatesPredicate("p")}
            QUALIFY ROW_NUMBER() OVER (
                PARTITION BY r.form_key
                ORDER BY p.load_order_idx DESC, r.plugin, r.origin) = 1
            """);

    // --- Working-tree changes (#415) ---

    // The columns `records` and `records_committed` share, in declaration order — named rather than
    // SELECT *'d so the snapshot copy below is pinned to a column list instead of to the two tables
    // happening to stay in the same order forever.
    private const string RecordColumnList =
        "form_key, plugin, origin, record_type, editor_id, \"ref\", body, content_hash";

    /// <summary>See <see cref="IRecordIndex.ApplyWorkingTreeChanges"/>. One transaction for the whole
    /// batch, matching <see cref="Index"/>'s own discipline: a throw partway leaves the prior read
    /// model intact rather than a half-applied edit whose Effective and Head disagree about which
    /// records diverged.</summary>
    public void ApplyWorkingTreeChanges(PluginKey key, IReadOnlyList<(string FormKey, string? Body)> deltas)
    {
        if (deltas.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        var structural = false;
        foreach (var (formKey, body) in deltas)
            structural |= ApplyOneWorkingTreeChange(key, formKey, body);

        // Only a delta that added or removed a row can move winner status: a field edit leaves the
        // stack exactly as it was. Re-swept for the whole load order rather than for the touched
        // FormKeys because UpdateWinners is the one definition of winning in this class, and a
        // second, scoped copy of that SQL is precisely how the two would come to disagree.
        //
        // #427 measured this once create/delete/renumber gave structural changes an actual user
        // gesture (each is single-FormKey, but every one now pays this cost on every call, unlike a
        // field edit): a throwaway fixture of 48,000 records across 60 participating plugins —
        // larger than the overwhelming majority of real load orders — put one whole-load-order
        // UpdateWinners() call at 18ms. That is not a hot path by any interactive-latency bar, so
        // this stays whole-load-order rather than FormKey-scoped; re-measure if a real load order's shape
        // ever makes this number look different.
        if (structural) UpdateWinners();
        tx.Commit();
    }

    /// <summary>Applies one delta. Returns true when it added or removed an Effective row — a
    /// <i>structural</i> change, the only kind that can move winner status.</summary>
    private bool ApplyOneWorkingTreeChange(PluginKey key, string formKey, string? body)
    {
        // The committed bytes, wherever they currently live: the snapshot if this record already
        // diverged, else the still-clean Effective row itself. Reading through the Head relation is
        // what makes those two cases one question rather than two branches that could drift apart.
        var committedBody = ScalarString(
            $"SELECT body FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);

        // #573: computed ahead of the guard below (rather than only after it, as before) because the
        // guard itself must consult Effective too — a record that never reached Head at all (still
        // working-tree-only, e.g. straight off CreateWorkingTreeRecord) is exactly as real to this
        // method as one that has, and both a delete (renumber's own "delete old FormKey" half) and an
        // edit of such a record were being silently dropped here on the mistaken assumption that no
        // Head answer meant no ref answered at all.
        var existedBefore = RowExistsAtEffective(key, formKey);

        if (committedBody == null && !existedBefore)
        {
            // Neither ref knows this record. A create is a lifecycle gesture with its own ticket, and
            // there is nothing here to derive its record_type/load_order_idx from, so this is a
            // caller mistake rather than a state to invent — logged, skipped, never thrown (the
            // seam's missing-data rule).
            _logger.LogWarning(
                "Ignoring a working-tree change for {FormKey}, which {Plugin} ({Origin}) does not hold at any ref",
                formKey, key.Name, key.Origin);
            return false;
        }

        SnapshotCommittedIfFirstDivergence(key, formKey);

        if (body == null)
        {
            // Deleted in the working tree: gone at Effective — document, lookup row and outgoing
            // references alike — while still answered at Head out of the snapshot taken immediately
            // above. Dropping only the document would leave the record resolvable and still sitting
            // in the reference graph, i.e. present in every derived answer and absent from the one
            // that stores it.
            ExecuteFor("DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            DeleteDerivationsForRecord(key, formKey);
            return existedBefore;
        }

        if (string.Equals(body, committedBody, StringComparison.Ordinal))
        {
            // Convergence, not a change (#413: byte compare is the detection). The record goes clean
            // again — including the case where it was *deleted* in the working tree and the file came
            // back, which is why this restores the row from the snapshot rather than assuming one is
            // still there to update.
            RestoreFromSnapshot(key, formKey);
            ExecuteFor("DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
        }
        else
        {
            UpsertEffectiveBody(key, formKey, body);
        }

        RederiveIndexRowsForRecord(key, formKey, body);
        return !existedBefore;
    }

    private bool RowExistsAtEffective(PluginKey key, string formKey) =>
        ScalarString("SELECT form_key FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    private bool RowExistsAtHead(PluginKey key, string formKey) =>
        ScalarString($"SELECT form_key FROM {HeadRelation} WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!) != null;

    /// <summary>See <see cref="IRecordIndex.CreateWorkingTreeRecord"/>.</summary>
    public void CreateWorkingTreeRecord(PluginKey key, string formKey, string recordType, string body)
    {
        if (RowExistsAtEffective(key, formKey) || RowExistsAtHead(key, formKey))
        {
            throw new ArgumentException(
                $"{key.Name} ({key.Origin}) already holds {formKey} at some ref — CreateWorkingTreeRecord " +
                "is only for a FormKey neither ref answers to.", nameof(formKey));
        }

        using var tx = Connection.BeginTransaction();
        InsertNewWorkingTreeRow(key, formKey, recordType, body);
        RederiveIndexRowsForRecord(key, formKey, body);
        // A create is always structural — a row that did not exist at Effective now does — so this
        // always resweeps, the same trigger ApplyOneWorkingTreeChange's own structural deltas use.
        UpdateWinners();
        tx.Commit();
    }

    // No existing Effective row to restore from and no committed snapshot to seed — a create writes
    // a row from scratch, straight to `ref = working-tree`, with nothing in records_committed. That
    // omission is exactly what makes records_head (records_committed UNION clean committed rows)
    // answer nothing for this FormKey without the view itself needing to know about creation at all.
    private void InsertNewWorkingTreeRow(PluginKey key, string formKey, string recordType, string body)
    {
        // #583 / ADR-0001: no load_order_idx to carry into the row any more — this check now exists
        // purely to keep the same refusal for a plugin the registration doesn't know, which
        // InsertNewWorkingTreeRow's callers (CreateWorkingTreeRecord) still rely on.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            INSERT INTO mirror.records (form_key, plugin, origin, record_type, editor_id, "ref", body, content_hash)
            VALUES ($1, $2, $3, $4, json_extract_string($5, '$.EditorID'), '{SourceRef.WorkingTree}', $5, $6)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = body });
        cmd.Parameters.Add(new DuckDBParameter { Value = GitBlobHash.Of(Encoding.UTF8.GetBytes(body)) });
        cmd.ExecuteNonQuery();

        // form_lookup's insert-if-absent branch in RederiveIndexRowsForRecord below reads this row
        // back out of `records`, which is why the insert above must land first.
    }

    private void DeleteIndexedFile(string plugin, string origin) =>
        ExecuteFor($"DELETE FROM {FilesRelation} WHERE plugin = $1 AND origin = $2", plugin, origin);

    private bool IsRegisteredPlugin(PluginKey key) =>
        ScalarString($"SELECT plugin FROM {TableDdlBuilder.RegistrationsRelation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin!) != null;

    /// <summary>See <see cref="IRecordIndex.SetCommittedBaseline"/>.</summary>
    public void SetCommittedBaseline(PluginKey key, IReadOnlyList<(string FormKey, string Body)> baselines)
    {
        if (baselines.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        foreach (var (formKey, body) in baselines)
            SetOneCommittedBaseline(key, formKey, body);
        tx.Commit();
    }

    private void SetOneCommittedBaseline(PluginKey key, string formKey, string body)
    {
        var effectiveBody = ScalarString(
            "SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (effectiveBody == null) return;

        if (string.Equals(effectiveBody, body, StringComparison.Ordinal))
        {
            // The working tree agrees with the new commit, so the record is clean and there is no
            // snapshot to keep — the ordinary "the user committed their edit in a terminal" case.
            ExecuteFor("DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            ExecuteFor($"""
                UPDATE mirror.records SET "ref" = '{SourceRef.Committed}'
                WHERE form_key = $1 AND plugin = $2 AND origin = $3
                """, formKey, key.Name, key.Origin!);
            return;
        }

        // Still dirty, but against a different baseline than before. The snapshot may not exist yet
        // (the record was clean and HEAD moved past it), so it is seeded from the Effective row first
        // and then overwritten with the committed bytes — only the body moved, so every identity
        // column is the same either way.
        SnapshotCommittedIfFirstDivergence(key, formKey);
        ExecuteFor("""
            UPDATE mirror.records_committed
            SET body = $4, content_hash = $5, editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!, body, GitBlobHash.Of(Encoding.UTF8.GetBytes(body)));
        ExecuteFor($"""
            UPDATE mirror.records SET "ref" = '{SourceRef.WorkingTree}'
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!);
    }

    /// <summary>See <see cref="IRecordIndex.MarkWorkingTreeOnly"/>.</summary>
    public void MarkWorkingTreeOnly(PluginKey key, IReadOnlyList<string> formKeys)
    {
        if (formKeys.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        foreach (var formKey in formKeys)
        {
            // The snapshot delete is not defensive padding: a fresh ingest leaves none behind, but this
            // is also reachable for a record that diverged earlier in the same load order, and a stale
            // snapshot would keep answering at Head through records_head's own UNION — which is exactly
            // the state this method exists to end.
            ExecuteFor("DELETE FROM mirror.records_committed WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!);
            ExecuteFor($"""
                UPDATE mirror.records SET "ref" = '{SourceRef.WorkingTree}'
                WHERE form_key = $1 AND plugin = $2 AND origin = $3
                """, formKey, key.Name, key.Origin!);
        }

        // Effective is untouched — nothing was added to or removed from it — but Head just lost a row
        // per FormKey, which can promote the next plugin down at that ref. Head's winners are swept,
        // not derived per read (#584 / ADR-0001), so the sweep has to run: whole-load-order, because
        // UpdateWinners is the one definition of winning in this class and a scoped copy of that SQL
        // is precisely how the two would come to disagree.
        UpdateWinners();
        tx.Commit();
    }

    /// <summary>See <see cref="IRecordIndex.SeedCommittedOnly"/>. One transaction for the whole batch,
    /// matching <see cref="SetCommittedBaseline"/> and <see cref="MarkWorkingTreeOnly"/> — the three
    /// head-state writes are all-or-nothing together, so a throw partway through a reconciliation pass
    /// cannot leave half of one applied.</summary>
    public void SeedCommittedOnly(PluginKey key, IReadOnlyList<(string FormKey, string RecordType, string Body)> records)
    {
        if (records.Count == 0) return;

        using var tx = Connection.BeginTransaction();
        foreach (var (formKey, recordType, body) in records)
            SeedOneCommittedOnly(key, formKey, recordType, body);

        // The mirror of MarkWorkingTreeOnly's sweep: Head just gained a row per FormKey, which can
        // demote whoever was winning it at that ref. Effective is untouched either way.
        UpdateWinners();
        tx.Commit();
    }

    private void SeedOneCommittedOnly(PluginKey key, string formKey, string recordType, string body)
    {
        if (RowExistsAtEffective(key, formKey) || RowExistsAtHead(key, formKey)) return;

        // #583 / ADR-0001: same refusal as InsertNewWorkingTreeRow's, now for its own sake rather
        // than as a side effect of fetching a load_order_idx this row no longer carries.
        if (!IsRegisteredPlugin(key))
            throw new InvalidOperationException($"{key.Name} ({key.Origin}) is not an indexed plugin.");

        // Straight into records_committed with no `records` counterpart — the exact inverse of
        // InsertNewWorkingTreeRow's "records row with no snapshot", and it falls out of records_head's
        // existing definition (the snapshot table UNION the still-clean rows) with no change to that
        // view: present in its first half, absent from its second.
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            INSERT INTO mirror.records_committed (form_key, plugin, origin, record_type, editor_id, "ref", body, content_hash)
            VALUES ($1, $2, $3, $4, json_extract_string($5, '$.EditorID'), '{SourceRef.Committed}', $5, $6)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Name });
        cmd.Parameters.Add(new DuckDBParameter { Value = key.Origin! });
        cmd.Parameters.Add(new DuckDBParameter { Value = recordType });
        cmd.Parameters.Add(new DuckDBParameter { Value = body });
        cmd.Parameters.Add(new DuckDBParameter { Value = GitBlobHash.Of(Encoding.UTF8.GetBytes(body)) });
        cmd.ExecuteNonQuery();
    }

    // Copies the still-clean Effective row aside the first time a record diverges, and does nothing
    // on every later edit of the same record — so the snapshot always holds the *committed* bytes,
    // never the previous working-tree ones.
    private void SnapshotCommittedIfFirstDivergence(PluginKey key, string formKey)
    {
        ExecuteFor($"""
            INSERT INTO mirror.records_committed ({RecordColumnList})
            SELECT {RecordColumnList} FROM mirror.records r
            WHERE r.form_key = $1 AND r.plugin = $2 AND r.origin = $3 AND r."ref" = '{SourceRef.Committed}'
              AND NOT EXISTS (
                SELECT 1 FROM mirror.records_committed c
                WHERE c.form_key = r.form_key AND c.plugin = r.plugin AND c.origin = r.origin)
            """, formKey, key.Name, key.Origin!);
    }

    private void RestoreFromSnapshot(PluginKey key, string formKey)
    {
        ExecuteFor("DELETE FROM mirror.records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        ExecuteFor($"""
            INSERT INTO mirror.records ({RecordColumnList})
            SELECT {RecordColumnList} FROM mirror.records_committed
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!);
    }

    private void UpsertEffectiveBody(PluginKey key, string formKey, string body)
    {
        var contentHash = GitBlobHash.Of(Encoding.UTF8.GetBytes(body));

        // An UPDATE alone would silently do nothing for a record the working tree had previously
        // deleted (no Effective row to update) and then edited back to a *different* value — so the
        // row is restored from the snapshot first when it is missing, and only then rewritten.
        if (ScalarString("SELECT body FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
                formKey, key.Name, key.Origin!) == null)
        {
            RestoreFromSnapshot(key, formKey);
        }

        // editor_id follows the body rather than being left at its committed value: it is a
        // *projection* of the document (the codec writes EditorID at the document's top level), and a
        // row whose identity column disagrees with its own body is a read model contradicting itself
        // — a renamed record would keep listing and resolving under its old EditorID everywhere
        // form_key isn't the lookup key. record_type is deliberately not re-derived: a record cannot
        // change type. Load order and winning are not on this row at all any more (#583/#584) — they
        // are facts about the plugin and the stack, not about these bytes.
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            UPDATE mirror.records
            SET body = $4, content_hash = $5, "ref" = '{SourceRef.WorkingTree}',
                editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [formKey, key.Name, key.Origin!, body, contentHash]);
        cmd.ExecuteNonQuery();
    }

    // The extracted index tables (ADR-0041: form_lookup and form_references are derived *from* the
    // document, never written independently of it) for one record, rebuilt from the bytes that just
    // landed. Ingest does exactly this per record inside its own per-plugin loop; here it happens for
    // one record at a time, through the same collectors, so an edit cannot leave the derived answers
    // describing bytes that no longer exist.
    private void RederiveIndexRowsForRecord(PluginKey key, string formKey, string body)
    {
        var recordType = ScalarString(
            "SELECT record_type FROM records WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (recordType == null || !RequireSchemas().TryGetValue(recordType, out var schema)) return;

        // form_lookup is *updated*, not delete-then-inserted: record_type cannot change (a record
        // does not change type), so editor_id is the whole delta, and a delete-then-insert would be
        // two statements doing one statement's work on the hot per-edit path.
        ExecuteFor("""
            UPDATE mirror.form_lookup SET editor_id = json_extract_string($4, '$.EditorID')
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """, formKey, key.Name, key.Origin!, body);

        // The row is absent when this record was previously deleted in the working tree and has now
        // come back — the one case where there is nothing to update.
        ExecuteFor($"""
            INSERT INTO mirror.form_lookup (form_key, plugin, origin, record_type, editor_id)
            SELECT r.form_key, r.plugin, r.origin, r.record_type, r.editor_id
            FROM mirror.records r
            WHERE r.form_key = $1 AND r.plugin = $2 AND r.origin = $3
              AND NOT EXISTS (
                SELECT 1 FROM mirror.form_lookup l
                WHERE l.form_key = r.form_key AND l.plugin = r.plugin AND l.origin = r.origin)
            """, formKey, key.Name, key.Origin!);

        var record = _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), _release, recordType)
            .GetAwaiter().GetResult();

        var refs = new List<FormRef>();
        CollectFormRefs(refs, record, recordType, schema);
        CollectVmadRefsForRecord(record, recordType, refs);
        CollectConditionRefsForRecord(record, recordType, refs);

        DeleteFormReferencesForRecord(key, formKey);
        if (refs.Count > 0)
        {
            using var refAppender = Connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                AppendFormReference(refAppender, r, key.Name, key.Origin!);
        }

        // #488: placement/cell_location/container_child now track Effective the same way
        // form_lookup/form_references already did — rebuilt from this same deserialized record,
        // through the same collectors ingest's own AppendDocument/IndexPlacement use.
        RederiveContainmentForRecord(key, formKey, recordType, record);
    }

    /// <summary>
    /// #488: rebuilds <c>container_child</c>/<c>placement</c>/<c>cell_location</c> for whatever
    /// <paramref name="record"/>'s own document embeds — a container's child <i>set</i> and slot
    /// order live entirely in the parent's own body (<see cref="ContainerChildFields.EnumerateChildren"/>
    /// re-reads current positions on every call), so a delete or a renumber that spliced/mutated that
    /// body is reflected here without any separate "what moved" bookkeeping. A full delete-then-insert
    /// per (parent, table) — cheap (one record's children, never the whole plugin) and correct by
    /// construction: the values are identical to what a fresh ingest of this same body would produce.
    ///
    /// <para>Recurses exactly one level, into a <c>Worldspace.TopCell</c> — the same bound
    /// <c>ContainerChildFields.FindEmbeddedChildSlot</c> already documents
    /// (<c>SpriggitEmbeddedSlots</c>): nothing else embeds a container inside a container, so a placed
    /// reference two levels inside a worldspace's document (the shape
    /// <c>EmbeddedChildEditTests.APlacedRefInsideAWorldspacesTopCell_IsEditable_TwoEmbedLevelsDeepInOneFile</c>
    /// exercises) still gets a current <c>placement</c> row.</para>
    ///
    /// <para>Harmless to call for a non-container record (most calls): <see cref="ContainerChildFields.EnumerateChildren"/>
    /// yields nothing, both deletes below match no rows, and nothing is inserted — the same
    /// "unreachable by construction" posture <c>RecordEditService</c>'s own containment guard relies
    /// on for the field-edit path.</para>
    /// </summary>
    private void RederiveContainmentForRecord(PluginKey key, string formKey, string recordType, IMajorRecordGetter record)
    {
        // Two different spellings of "what type is this", each answering to a different consumer:
        // the CLR-name form (Cell, Worldspace) is what CoveredByPlacementTables and
        // ContainerChildFields.EnumerateChildren key off; the schema-table-name form (cell, "cell") is
        // what a stored ContainerChildRow.ParentRecordType must carry, because that is what
        // AppendDocument's own ingest-time row already stores and what downstream readers
        // (SourceUnitResolver.ScanSubtree's RecordTypeDispatch lookups) compare against.
        var slotLookupType = ContainerChildFields.NormalizedTypeName(record.GetType());
        var containerChildRows = new List<ContainerChildRow>();
        var placementRows = new List<PlacementRow>();
        CellLocationRow? topCellRow = null;
        IMajorRecordGetter? topCellRecord = null;

        foreach (var (slotName, slotIndex, child) in ContainerChildFields.EnumerateChildren(record))
        {
            if (!CoveredByPlacementTables.Contains((slotLookupType, slotName)))
            {
                containerChildRows.Add(new ContainerChildRow(
                    child.FormKey.ToString(), formKey, recordType, slotName, slotIndex));
                continue;
            }

            switch (slotName)
            {
                case "Persistent":
                    placementRows.Add(_placementWalker.EmitPlacementRow(child, formKey, "persistent"));
                    break;
                case "Temporary":
                    placementRows.Add(_placementWalker.EmitPlacementRow(child, formKey, "temporary"));
                    break;
                case "TopCell":
                    // No block/sub and never interior, by construction — a worldspace's top cell is
                    // not part of any exterior grid (PlacementWalker.WalkWorldspace's own ingest walk
                    // uses these same three constants for the identical reason).
                    topCellRow = _placementWalker.EmitCellLocationRow(
                        child, formKey, blockX: null, blockY: null, subX: null, subY: null, isInterior: false);
                    topCellRecord = child;
                    break;
                    // "SubCells": never yielded here — its items are WorldspaceBlock, which is not
                    // IMajorRecordGetter (ContainerChildFields.EnumerateChildren's own doc comment).
            }
        }

        ExecuteFor("DELETE FROM mirror.container_child WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (containerChildRows.Count > 0)
        {
            using var appender = Connection.CreateAppender("mirror", "container_child");
            foreach (var row in containerChildRows)
                AppendContainerChildRow(appender, row, key.Name, key.Origin!);
        }

        ExecuteFor("DELETE FROM mirror.placement WHERE parent_cell = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        if (placementRows.Count > 0)
        {
            using var appender = Connection.CreateAppender("mirror", "placement");
            foreach (var row in placementRows)
                AppendPlacementRow(appender, row, key.Name, key.Origin!);
        }

        if (topCellRow is not { } cellRow || topCellRecord == null) return;

        ExecuteFor("DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            cellRow.CellFormKey, key.Name, key.Origin!);
        using (var appender = Connection.CreateAppender("mirror", "cell_location"))
            AppendCellLocationRow(appender, cellRow, key.Name, key.Origin!);

        // The top cell is itself a container (its own Persistent/Temporary/Landscape/
        // NavigationMeshes), one level deeper in the very same document. "cell" is the schema
        // table name a Cell's own GRUP signature ("CELL") always lowercases to — a TopCell slot can
        // only ever hold a Cell, so this is not a guess the way a general record's recordType would be.
        RederiveContainmentForRecord(key, cellRow.CellFormKey, "cell", topCellRecord);
    }

    private static void AppendContainerChildRow(DuckDBAppender appender, ContainerChildRow row, string plugin, string origin)
    {
        var r = appender.CreateRow();
        r.AppendValue(row.ChildFormKey);
        r.AppendValue(plugin);
        r.AppendValue(origin);
        r.AppendValue(row.ParentFormKey);
        r.AppendValue(row.ParentRecordType);
        r.AppendValue(row.SlotName);
        r.AppendValue(row.SlotIndex);
        r.EndRow();
    }

    private static void AppendPlacementRow(DuckDBAppender appender, PlacementRow row, string plugin, string origin)
    {
        var r = appender.CreateRow();
        r.AppendValue(row.FormKey);
        r.AppendValue(plugin);
        r.AppendValue(origin);
        r.AppendValue(row.ParentCell);
        r.AppendValue(row.PlacementGroup);
        DuckDbAppend.Nullable(r, row.PosX);
        DuckDbAppend.Nullable(r, row.PosY);
        DuckDbAppend.Nullable(r, row.PosZ);
        r.EndRow();
    }

    private static void AppendCellLocationRow(DuckDBAppender appender, CellLocationRow row, string plugin, string origin)
    {
        var r = appender.CreateRow();
        r.AppendValue(row.CellFormKey);
        r.AppendValue(plugin);
        r.AppendValue(origin);
        DuckDbAppend.Nullable(r, row.ParentWorldspace);
        DuckDbAppend.Nullable(r, row.BlockX);
        DuckDbAppend.Nullable(r, row.BlockY);
        DuckDbAppend.Nullable(r, row.SubX);
        DuckDbAppend.Nullable(r, row.SubY);
        DuckDbAppend.Nullable(r, row.GridX);
        DuckDbAppend.Nullable(r, row.GridY);
        r.AppendValue(row.IsInterior);
        r.EndRow();
    }

    private void DeleteDerivationsForRecord(PluginKey key, string formKey)
    {
        ExecuteFor("DELETE FROM mirror.form_lookup WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        DeleteFormReferencesForRecord(key, formKey);
        DeleteContainmentForRecord(key, formKey);
    }

    private void DeleteFormReferencesForRecord(PluginKey key, string formKey) =>
        ExecuteFor(
            "DELETE FROM mirror.form_references WHERE source_form_key = $1 AND source_plugin = $2 AND source_origin = $3",
            formKey, key.Name, key.Origin!);

    /// <summary>
    /// #488: the three side tables' rows for a record that just stopped existing at Effective — its
    /// own facts (a placed ref's <c>placement</c> row, a cell's <c>cell_location</c> row, a
    /// folder-split child's <c>container_child</c> row), plus, defensively, whatever names it as a
    /// parent. The defensive half is a backstop, not the primary mechanism: <c>DeleteRecord</c>'s own
    /// descendant cascade (<c>EnumerateDescendantFormKeys</c>) already gives every descendant its own
    /// null-body delta, which reaches this same method for each of them individually — so a deleted
    /// container's children lose their rows via their <i>own</i> deletion, not by this record's
    /// parent-side cleanup alone.
    /// </summary>
    private void DeleteContainmentForRecord(PluginKey key, string formKey)
    {
        ExecuteFor("DELETE FROM mirror.placement WHERE form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        ExecuteFor("DELETE FROM mirror.placement WHERE parent_cell = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        ExecuteFor("DELETE FROM mirror.cell_location WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        ExecuteFor("DELETE FROM mirror.container_child WHERE child_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
        ExecuteFor("DELETE FROM mirror.container_child WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3",
            formKey, key.Name, key.Origin!);
    }

    private string? ScalarString(string sql, params string[] values)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        return cmd.ExecuteScalar() as string;
    }

    private void ExecuteFor(string sql, params string[] values)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        cmd.ExecuteNonQuery();
    }

    // --- Queries ---

    // #415: the two relations the ref dimension resolves to. `records` holds one row per record copy
    // and that row *is* Effective, so every read below reaches its ref by naming a relation of the
    // same shape — no read carries a ref predicate, and none of them changed shape to gain a ref.
    // `records_head` is the UNION of the committed snapshots of diverged records with the rows that
    // never diverged (TableDdlBuilder.CreateCommittedRecordsTableAndHeadView).
    private const string EffectiveRelation = "records";
    private const string HeadRelation = "records_head";

    // Created on first ask and reused: it is a stateless projection over this same connection, and
    // At() is called per read on hot paths (GetCompare walks an override stack through it).
    private IRecordReads? _headReads;

    /// <summary>
    /// #415: Head and Effective now genuinely diverge — a record carrying a working-tree change
    /// serves the edited bytes at <see cref="RecordRef.Effective"/> and the committed ones at
    /// <see cref="RecordRef.Head"/>. For a record with no working-tree change the two relations hold
    /// the same row by construction, so the answers stay identical, which is what
    /// <c>RecordRefDivergenceTests</c> still pins for the unedited case.
    ///
    /// <para>The reads that answer from the <i>extracted</i> index tables rather than from documents
    /// — <see cref="Resolve"/>, <see cref="GetReferencedBy"/>, <see cref="GetPlacement"/> — answer
    /// identically at both refs, deliberately: those tables carry no ref dimension, they track
    /// Effective (a FormKey should resolve to what the link points at *now*), and the committed
    /// question every consumer in this ticket actually asks is a document question, answered from
    /// <see cref="RecordOverrides"/>'s own Head bodies.</para>
    /// </summary>
    public IRecordReads At(RecordRef recordRef)
    {
        if (recordRef != RecordRef.Head) return this;
        _headReads ??= new RefScopedReads(this, HeadRelation);
        return _headReads;
    }

    /// <summary>
    /// One ref's worth of <see cref="IRecordReads"/>, differing from the default surface only in
    /// which relation its SQL names. Every member forwards to the same private implementation the
    /// outer instance's own public members forward to — so a read cannot be ref-aware on one path
    /// and not the other, which is exactly the failure mode a second read implementation would
    /// invite.
    /// </summary>
    private sealed class RefScopedReads(DuckDbRecordIndex owner, string records) : IRecordReads
    {
        public RecordDocument? GetDocument(string formKey) => owner.GetWinningDocument(records, formKey);
        public RecordDocument? GetDocument(string formKey, PluginKey plugin) => owner.GetPluginDocument(records, formKey, plugin);
        public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) => owner.GetPluginDocuments(records, plugin);
        public RecordOverrides? GetOverrideStack(string formKey) => owner.GetOverrideStack(records, formKey);
        public PagedResult<RecordSummary> Search(RecordQuery query) => owner.Search(records, query);
        public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) => owner.GetRecordTypeCounts(records, plugin);
        public IReadOnlyList<string> GetContestedFormKeys() => owner.GetContestedFormKeys(records);
        public RecordLookupEntry? Resolve(string formKey) => owner.ResolveFormKey(formKey);
        public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => owner.GetReferences(targetFormKey);
        public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
            owner.GetPluginsWithMatchingRecords(records, tableNames);
        public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) => owner.GetNativeFormKeys(records, plugin.Name, plugin.Origin!);
        public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) => owner.GetEffectiveMasters(records, plugin);
        public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) =>
            owner.GetWorldspaceCells(records, plugin.Name, worldspaceFormKey, plugin.Origin!);
        public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset) =>
            owner.GetInteriorCells(records, plugin.Name, limit, offset, plugin.Origin!);
        public CellReferences GetCellReferences(PluginKey plugin, string cellFormKey) =>
            owner.GetCellReferences(records, plugin.Name, cellFormKey, plugin.Origin!);
        public PlacementRow? GetPlacement(string formKey, PluginKey plugin) =>
            owner.GetPlacement(formKey, plugin.Name, plugin.Origin!);
        public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) =>
            owner.GetCellLocation(cellFormKey, plugin.Name, plugin.Origin!);
        public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
            owner.GetContainerChildren(plugin.Name, plugin.Origin!, parentFormKey);
        public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
            owner.GetContainerParent(plugin.Name, plugin.Origin!, childFormKey);
    }

    public RecordDocument? GetDocument(string formKey) => GetWinningDocument(EffectiveRelation, formKey);

    public RecordDocument? GetDocument(string formKey, PluginKey plugin) =>
        GetPluginDocument(EffectiveRelation, formKey, plugin);

    private RecordDocument? GetWinningDocument(string records, string formKey)
    {
        RequireSchemas(); // fail before touching the DB when Initialize hasn't run, matching every other read here
        var tableName = FindRecordType(records, formKey);
        return tableName == null ? null : ReadDocument(records, tableName, formKey, plugin: null, origin: null, winnerOnly: true);
    }

    private RecordDocument? GetPluginDocument(string records, string formKey, PluginKey plugin)
    {
        RequireSchemas();
        var tableName = FindRecordType(records, formKey);
        return tableName == null ? null : ReadDocument(records, tableName, formKey, plugin.Name, plugin.Origin, winnerOnly: false);
    }

    public IReadOnlyList<RecordDocument> GetDocuments(PluginKey plugin) =>
        GetPluginDocuments(EffectiveRelation, plugin);

    // #547: one query where GetPluginDocument's callers used to loop two point queries per record
    // (FindRecordType + ReadDocument — ~7,880 round trips for one compile of the real 3,940-record
    // fixture). Rows are materialized before any reconstitution: resolving a referenced FormKey
    // opens its own command on this same connection, and doing that under a live reader would
    // interleave two readers (GetOverrideStack's #415 note).
    private List<RecordDocument> GetPluginDocuments(string records, PluginKey plugin)
    {
        var schemas = RequireSchemas();
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, record_type
            FROM {records}
            WHERE plugin = $1 AND origin = $2
            """;
        AddParams(cmd, [plugin.Name, plugin.Origin!]);
        using var reader = cmd.ExecuteReader();

        var rows = new List<(string FormKey, string Plugin, string Origin, int LoadOrderIndex,
            bool IsWinner, string? EditorId, string Body, string RecordType)>();
        while (reader.Read())
        {
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetString(2),
                LoadOrderSortKey(reader, 3), reader.GetBoolean(4),
                reader.IsDBNull(5) ? null : reader.GetString(5),
                reader.GetString(6), reader.GetString(7)));
        }
        reader.Close();

        // One resolution cache for the whole batch, not one per document — the same referenced
        // FormKey (a shared keyword, a race) recurs across a plugin's records, and every miss is a
        // form_lookup query of its own. Resolution is a pure lookup, so sharing changes nothing
        // about any single document's CheckErrors.
        var cache = new Dictionary<string, RecordLookupEntry?>();
        RecordLookupEntry? Resolve(string fk)
        {
            if (cache.TryGetValue(fk, out var t)) return t;
            var resolved = ResolveFormKey(fk);
            cache[fk] = resolved;
            return resolved;
        }

        var documents = new List<RecordDocument>(rows.Count);
        foreach (var row in rows)
        {
            // Same defensive skip as RederiveIndexRowsForRecord: a record_type no schema claims
            // has no reconstitution path.
            if (!schemas.TryGetValue(row.RecordType, out var schema)) continue;
            documents.Add(DocumentFromBody(
                row.FormKey, row.Plugin, row.Origin, row.LoadOrderIndex, row.IsWinner,
                row.EditorId, row.Body, schema, Resolve));
        }
        return documents;
    }

    private RecordDocument? ReadDocument(string records, string tableName, string formKey, string? plugin, string? origin, bool winnerOnly)
    {
        var schema = RequireSchemas()[tableName];
        var conditions = new List<string> { "form_key = $1" };
        var values = new List<string> { formKey };

        if (winnerOnly) conditions.Add("is_winner = true");
        if (plugin != null) { conditions.Add($"plugin = ${values.Count + 1}"); values.Add(plugin); }
        if (origin != null) { conditions.Add($"origin = ${values.Count + 1}"); values.Add(origin); }

        var isHeader = IsHeaderTable(tableName);
        if (!isHeader) { conditions.Add($"record_type = ${values.Count + 1}"); values.Add(NormalizeRecordType(tableName)); }

        var where = " WHERE " + string.Join(" AND ", conditions);
        var sql = isHeader
            ? $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
                FROM "{HeaderIndexer.TableName}"{where}
                LIMIT 1
                """
            : $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body
                FROM {records}{where}
                LIMIT 1
                """;

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, values);
        using var reader = cmd.ExecuteReader();
        if (!reader.Read()) return null;

        var cache = new Dictionary<string, RecordLookupEntry?>();
        RecordLookupEntry? Resolve(string fk)
        {
            if (cache.TryGetValue(fk, out var t)) return t;
            var resolved = ResolveFormKey(fk);
            cache[fk] = resolved;
            return resolved;
        }

        return isHeader
            ? ReadDocumentFromColumns(reader, schema, Resolve)
            : ReadDocumentFromBody(reader, schema, Resolve);
    }

    public RecordOverrides? GetOverrideStack(string formKey) => GetOverrideStack(EffectiveRelation, formKey);

    private RecordOverrides? GetOverrideStack(string records, string formKey)
    {
        RequireSchemas(); // fail before touching the DB when Initialize hasn't run, matching every other read here
        var tableName = FindRecordType(records, formKey);
        if (tableName == null) return null;
        var schema = RequireSchemas()[tableName];
        var isHeader = IsHeaderTable(tableName);
        var sql = isHeader
            ? $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id{ColumnList(schema)}
                FROM "{HeaderIndexer.TableName}"
                WHERE form_key = $1
                ORDER BY load_order_idx
                """
            : $"""
                SELECT form_key, plugin, origin, load_order_idx, is_winner, editor_id, body, "ref"
                FROM {records}
                WHERE form_key = $1 AND record_type = $2
                ORDER BY load_order_idx
                """;
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        if (!isHeader)
            cmd.Parameters.Add(new DuckDBParameter { Value = NormalizeRecordType(tableName) });
        using var reader = cmd.ExecuteReader();

        var cache = new Dictionary<string, RecordLookupEntry?>();
        RecordLookupEntry? Resolve(string fk)
        {
            if (cache.TryGetValue(fk, out var t)) return t;
            var resolved = ResolveFormKey(fk);
            cache[fk] = resolved;
            return resolved;
        }

        // #415: read the whole stack out before resolving any Head counterpart — ReadDocument opens
        // its own command on this same connection, and doing that while this reader is still open
        // would interleave two readers on one DuckDB connection.
        var rows = new List<(RecordDocument Document, bool IsDirty)>();
        while (reader.Read())
        {
            var doc = isHeader
                ? ReadDocumentFromColumns(reader, schema, Resolve)
                : ReadDocumentFromBody(reader, schema, Resolve);
            // The header carries no `ref` column at all (D8: it has no document), so it is never
            // dirty here. On a Head-scoped read every row is committed by construction, so this
            // reads false for all of them without needing to know which relation it is on.
            var isDirty = !isHeader && reader.GetString(7) == SourceRef.WorkingTree;
            rows.Add((doc, isDirty));
        }
        reader.Close();

        var entries = new List<OverrideStackEntry>();
        foreach (var (doc, isDirty) in rows)
        {
            // #415: a clean entry keeps Head and Effective as the same instance — not merely equal
            // values — so "did this change" stays answerable by identity on the hot, overwhelmingly
            // common path. A dirty one resolves its committed counterpart from the Head relation.
            var head = isDirty
                ? ReadDocument(HeadRelation, tableName, doc.FormKey, doc.Plugin.Name, doc.Plugin.Origin, winnerOnly: false) ?? doc
                : doc;
            entries.Add(new OverrideStackEntry(doc.Plugin, doc.LoadOrderIndex, doc.IsWinner, doc, head, isDirty));
        }

        return entries.Count == 0 ? null : new RecordOverrides(formKey, tableName, entries);
    }

    public PagedResult<RecordSummary> Search(RecordQuery query) => Search(EffectiveRelation, query);

    private PagedResult<RecordSummary> Search(string records, RecordQuery query)
    {
        var (where, paramValues) = BuildWhere(
            query.Plugin?.Name, query.Search, _filterActive, query.Plugin?.Origin, query.RecordTypes);
        // #428: "ref" plus a records_committed existence check is exactly the pair
        // RecordSummaryWorkingTreeStateTests pins — Modified is ref='working-tree' with a committed
        // snapshot on record; Added is the same ref with no snapshot at all (CreateWorkingTreeRecord's
        // own doc comment: a create writes nothing into records_committed). The `r` alias is needed
        // only for the correlated EXISTS below; `where`'s own unqualified column references still
        // resolve against it unambiguously, since it is the sole table this query's FROM names.
        const string cols = """
            form_key, plugin, load_order_idx, is_winner, editor_id, origin, r."ref",
            EXISTS (
                SELECT 1 FROM records_committed rc
                WHERE rc.form_key = r.form_key AND rc.plugin = r.plugin AND rc.origin = r.origin
            ) AS has_committed_snapshot
            """;

        using var countCmd = Connection.CreateCommand();
        countCmd.CommandText = $"SELECT COUNT(*) FROM {records}{where}";
        AddParams(countCmd, paramValues);
        var total = (long)countCmd.ExecuteScalar()!;

        // #458: editor_id alone is not unique — blank/duplicate EditorIDs are ordinary, and overrides
        // of one record across plugins share one by definition — so LIMIT/OFFSET paging over it with
        // no tiebreak lets DuckDB place tied rows on either side of a page boundary differently
        // across calls, silently skipping some and repeating others. (form_key, plugin, origin) is
        // this table's own identity (see CreateRecordsTable's doc comment), so appending it makes the
        // order total and paging stable.
        using var dataCmd = Connection.CreateCommand();
        dataCmd.CommandText = $"""
            SELECT {cols} FROM {records} r{where}
            ORDER BY editor_id, form_key, plugin, origin
            LIMIT {query.Limit} OFFSET {query.Offset}
            """;
        AddParams(dataCmd, paramValues);

        var items = new List<RecordSummary>();
        using var reader = dataCmd.ExecuteReader();
        while (reader.Read())
            items.Add(ReadSummary(reader));

        return new PagedResult<RecordSummary>(items, (int)total);
    }

    // The filter narrows counts the same way it narrows listings (invariant: SetFilter affects
    // Search/counts/plugin-highlight, never a point read) — routed through the same BuildWhere every
    // other filterable query here uses, rather than a bespoke WHERE that would silently miss it.
    public IReadOnlyList<RecordTypeCount> GetRecordTypeCounts(PluginKey plugin) =>
        GetRecordTypeCounts(EffectiveRelation, plugin);

    private List<RecordTypeCount> GetRecordTypeCounts(string records, PluginKey plugin)
    {
        var (where, paramValues) = BuildWhere(plugin.Name, null, _filterActive, plugin.Origin, recordTypes: null);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type, COUNT(*) FROM {records}{where} GROUP BY record_type";
        AddParams(cmd, paramValues);
        using var reader = cmd.ExecuteReader();

        var counts = new List<RecordTypeCount>();
        while (reader.Read())
            counts.Add(new RecordTypeCount(reader.GetString(0), (int)reader.GetInt64(1)));
        return counts;
    }

    // #364: same filter-narrowing invariant as GetRecordTypeCounts above — routed through the same
    // BuildWhere, so a filter that prunes a FormKey out of Search/counts prunes it out of the
    // Conflicts node's candidate population too, with nothing bespoke to drift out of sync.
    public IReadOnlyList<string> GetContestedFormKeys() => GetContestedFormKeys(EffectiveRelation);

    private List<string> GetContestedFormKeys(string records)
    {
        var (where, paramValues) = BuildWhere(null, null, _filterActive, null, recordTypes: null);
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT form_key FROM {records}{where}
            GROUP BY form_key
            HAVING COUNT(*) > 1
            """;
        AddParams(cmd, paramValues);
        using var reader = cmd.ExecuteReader();

        var formKeys = new List<string>();
        while (reader.Read())
            formKeys.Add(reader.GetString(0));
        return formKeys;
    }

    public RecordLookupEntry? Resolve(string formKey) => ResolveFormKey(formKey);

    public IReadOnlyList<ReferenceResult> GetReferencedBy(string targetFormKey) => GetReferences(targetFormKey);

    /// <summary>
    /// See <see cref="IRecordReads.GetEffectiveMasters"/> — derived, not declared. Union of (a) the
    /// owning plugin of every FormKey this plugin's records reference outward (<c>form_references</c>)
    /// and (b) the owning plugin of every FormKey this plugin carries that isn't native to it (an
    /// override forces that master), in deterministic load-order order, excluding the plugin itself.
    /// A master this plugin's header declares but nothing in it references or overrides is not
    /// effective, and is excluded — the ADR-0038 "effective masters" concept, reimplemented against
    /// the read model instead of a write-time content walk.
    /// </summary>
    public IReadOnlyList<string> GetEffectiveMasters(PluginKey plugin) =>
        GetEffectiveMasters(EffectiveRelation, plugin);

    private IReadOnlyList<string> GetEffectiveMasters(string records, PluginKey plugin)
    {
        var required = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        using (var cmd = Connection.CreateCommand())
        {
            cmd.CommandText = "SELECT DISTINCT target_form_key FROM form_references WHERE source_plugin = $1 AND source_origin = $2";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                if (ModKeyNameOf(reader.GetString(0)) is { } name) required.Add(name);
            }
        }

        using (var cmd = Connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT DISTINCT form_key FROM {records} WHERE plugin = $1 AND origin = $2";
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Name });
            cmd.Parameters.Add(new DuckDBParameter { Value = plugin.Origin });
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
            {
                var fk = reader.GetString(0);
                if (ModKeyNameOf(fk) is { } name && !string.Equals(name, plugin.Name, StringComparison.OrdinalIgnoreCase))
                    required.Add(name);
            }
        }

        required.Remove(plugin.Name);
        if (required.Count == 0) return [];

        // Deterministic load-order order: a master the load order holds sorts by its own
        // load_order_idx; one it doesn't (referenced but never registered, or registered with no
        // slot) falls after every listed master, alphabetically among themselves, so the result is
        // stable either way.
        var order = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        using (var cmd = Connection.CreateCommand())
        {
            cmd.CommandText = $"SELECT plugin, MIN(load_order_idx) FROM {TableDdlBuilder.RegistrationsRelation} WHERE load_order_idx IS NOT NULL GROUP BY plugin";
            using var reader = cmd.ExecuteReader();
            while (reader.Read())
                order[reader.GetString(0)] = reader.GetInt32(1);
        }

        return [.. required
            .OrderBy(n => order.GetValueOrDefault(n, int.MaxValue))
            .ThenBy(n => n, StringComparer.OrdinalIgnoreCase)];
    }

    // The plugin-filename half of a stored FormKey ("012345:Base.esm" -> "Base.esm") — mirrors
    // GetNativeFormKeys' own colon-split, reused here for GetEffectiveMasters' derivation.
    private static string? ModKeyNameOf(string formKey)
    {
        var colon = formKey.IndexOf(':');
        return colon > 0 ? formKey[(colon + 1)..] : null;
    }

    /// <summary>Reads a record's document row into a <see cref="RecordDocument"/>, reconstituted
    /// through <see cref="RecordTextCodec"/> and extracted via <see cref="ExtractFields"/> — see
    /// that method's own doc comment for why the values are identical to the pre-#413 wide-table
    /// path by construction.</summary>
    private RecordDocument ReadDocumentFromBody(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey) =>
        DocumentFromBody(
            reader.GetString(0), reader.GetString(1), reader.GetString(2), LoadOrderSortKey(reader, 3),
            reader.GetBoolean(4), reader.IsDBNull(5) ? null : reader.GetString(5),
            reader.GetString(6), schema, resolveFormKey);

    // #547: the construction half of ReadDocumentFromBody, split out so the bulk read can build
    // documents from rows it materialized before reconstituting any of them.
    private RecordDocument DocumentFromBody(
        string formKey, string plugin, string origin, int loadOrderIndex, bool isWinner,
        string? editorId, string body, RecordTableSchema schema,
        Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var record = _codec
            .DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(body), _release, schema.TableName)
            .GetAwaiter().GetResult();

        return new RecordDocument(
            formKey, new PluginKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName,
            body, ExtractFields(schema, record, resolveFormKey), PartialFormFlag.IsSet(record),
            PartialFormFlag.IsPartialFormable(record.GetType()));
    }

    /// <summary>The header's own reader (D8: no document) — reads straight off the header table's
    /// real per-field columns. <see cref="RecordDocument.Body"/> is null.</summary>
    private static RecordDocument ReadDocumentFromColumns(
        DuckDBDataReader reader, RecordTableSchema schema, Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var formKey = reader.GetString(0);
        var plugin = reader.GetString(1);
        var origin = reader.GetString(2);
        var loadOrderIndex = LoadOrderSortKey(reader, 3);
        var isWinner = reader.GetBoolean(4);
        var editorId = reader.IsDBNull(5) ? null : reader.GetString(5);

        var fields = new List<FieldValue>();
        for (int i = 0; i < schema.RecordColumns.Count; i++)
        {
            var col = schema.RecordColumns[i];
            var isDbNull = reader.IsDBNull(6 + i);
            object? value = (isDbNull, col.IsArray || col.SubFields != null) switch
            {
                (true, _) => null,
                (false, true) => JsonSerializer.Deserialize<JsonElement>(reader.GetString(6 + i)),
                _ => reader.GetValue(6 + i),
            };
            if (value != null && col.IsBitmask)
                value = Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);
            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(meta, value, resolveFormKey)));
        }

        return new RecordDocument(formKey, new PluginKey(plugin, origin), loadOrderIndex, isWinner, editorId, schema.TableName, null, fields);
    }

    /// <summary>
    /// The ColumnSpec.Extract walk every reconstitution path shares (#413 D1) — extracts a record's
    /// typed fields from its live Mutagen object, the shape both <see cref="ReadDocumentFromBody"/>
    /// and (via <c>RecordQueryService.ToRecordDetail</c>-adjacent callers) the rest of the read
    /// model build on.
    ///
    /// <para>The record is reconstituted through <see cref="RecordTextCodec"/> and then read by the
    /// <b>same <see cref="ColumnSpec.Extract"/> delegates</b> that the wide tables were filled with,
    /// pre-#413. That is what makes the values identical by construction rather than by a second
    /// implementation agreeing with the first — and it is why the published relational schema can be
    /// the SQL door's contract without also being the C# surface's (invariant 8): the document body
    /// is Mutagen's serializer shape, which has no per-column correspondence to the reflected schema
    /// at all (defaults omitted, translated strings as objects, flags as name arrays, and the
    /// #263/#339 widened and split columns with no JSON path whatsoever).</para>
    ///
    /// <para>Each extracted value then passes through the same two normalizations the wide path
    /// applied on the way in and out, so a field's JSON is byte-for-byte what it was: coerced to the
    /// column's declared DuckDB type (<see cref="CoerceToColumnType"/>, mirroring
    /// <see cref="AppendTyped"/>), and bitmasks rendered as decimal strings.</para>
    /// </summary>
    private static List<FieldValue> ExtractFields(
        RecordTableSchema schema, IMajorRecord record, Func<string, RecordLookupEntry?> resolveFormKey)
    {
        var fields = new List<FieldValue>();
        foreach (var col in schema.RecordColumns)
        {
            var raw = CoerceToColumnType(col.Extract(record), col.DuckDbType);

            var isJsonText = col.IsArray || col.SubFields != null;
            object? value = raw switch
            {
                null => null,
                string text when isJsonText => JsonSerializer.Deserialize<JsonElement>(text),
                _ => raw,
            };

            if (value != null && col.IsBitmask)
                value = Convert.ToInt64(value, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture);

            var meta = col.ToFieldMetadata();
            fields.Add(new FieldValue(meta, value, CheckErrorBuilder.Build(meta, value, resolveFormKey)));
        }
        return fields;
    }

    // end #421 new-seam block

    // #421: GetVmad/GetConditions and their reconstitution helpers (ReadRecordBody,
    // DecodeParamValue, the VMAD Map* tree) moved to Queries/RecordDocumentCodecs, which operates
    // on RecordDocument.Body instead of re-querying `records` — see that file.

    // #413: one indexed lookup where this used to scan every per-type table in turn until one
    // matched — the record's type is a column now, so there is nothing to search for.
    //
    // The header keeps its own second lookup for the same reason it keeps its own read path (D8):
    // it has no document, so it is absent from `records` entirely. The old per-table scan covered it
    // only because "header" happened to be one of the schema keys it walked; that coverage is
    // deliberate behaviour (Open Header resolves a plugin's synthetic 000000:<plugin> FormKey
    // through here), so it is expressed explicitly rather than lost with the scan.
    //
    // #421: private now — table-name dispatch is explicitly rejected from the seam; GetDocument and
    // GetOverrideStack resolve a FormKey's type themselves rather than being told it.
    private string? FindRecordType(string records, string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT record_type FROM {records} WHERE form_key = $1 LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        if (cmd.ExecuteScalar() is string recordType) return recordType;

        using var headerCmd = Connection.CreateCommand();
        headerCmd.CommandText = $"SELECT 1 FROM \"{HeaderIndexer.TableName}\" WHERE form_key = $1 LIMIT 1";
        headerCmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        return headerCmd.ExecuteScalar() != null ? HeaderIndexer.TableName : null;
    }

    // #421: private — Resolve(formKey) is the public seam member; kept under its old name since
    // ReadDocument/GetOverrideStack's own local Resolve closures already call it by this name.
    private RecordLookupEntry? ResolveFormKey(string formKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "SELECT record_type, editor_id FROM form_lookup WHERE form_key = $1 AND is_winner LIMIT 1";
        cmd.Parameters.Add(new DuckDBParameter { Value = formKey });
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358), matching GetPlacement's NullableFloat pattern.
        string? NullableEditorId() => reader.IsDBNull(1) ? null : reader.GetString(1);

        return !reader.Read()
            ? null
            : new RecordLookupEntry(reader.GetString(0), NullableEditorId());
    }

    public IReadOnlyList<string> GetNativeFormKeys(PluginKey plugin) =>
        GetNativeFormKeys(EffectiveRelation, plugin.Name, plugin.Origin!);

    // #421: private — GetNativeFormKeys(PluginKey) above is the public seam member and delegates here.
    private List<string> GetNativeFormKeys(string records, string plugin, string origin)
    {
        // #413: fourth union shape collapsed. The header exclusion the union expressed by omitting a
        // table is now implicit — a ModHeader is not a major record, so it has no document at all.
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT form_key FROM {records} WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var result = new List<string>();
        while (reader.Read())
        {
            var fk = reader.GetString(0);
            var colon = fk.IndexOf(':');
            // "Native" = the record's own FormKey ModKey is this plugin (not an override of a master).
            if (colon > 0 && fk.AsSpan(colon + 1).Equals(plugin, StringComparison.OrdinalIgnoreCase))
                result.Add(fk);
        }
        return result;
    }

    // --- Helpers ---

    /// <summary>ADR-0044: a record row's <c>load_order_idx</c> is its column's <i>sort key</i>, and
    /// a registered copy no <c>plugins.txt</c> line names has none (NULL) — it sorts after every
    /// listed copy, the same place the unlisted-plugin door used to put it. The plugin-level wire
    /// (<c>PluginResponse.LoadOrderIndex</c>) keeps the honest null; here, where every consumer
    /// orders columns by the value and never reads it as a fact, a sentinel is the sort rule.</summary>
    private static int LoadOrderSortKey(DuckDBDataReader reader, int ordinal) =>
        reader.IsDBNull(ordinal) ? int.MaxValue : reader.GetInt32(ordinal);

    private static RecordSummary ReadSummary(DuckDBDataReader reader) =>
        new(reader.GetString(0), reader.GetString(1), LoadOrderSortKey(reader, 2),
            reader.GetBoolean(3), reader.IsDBNull(4) ? null : reader.GetString(4), reader.GetString(5),
            ReadWorkingTreeState(reader));

    // #428: column 6 is "ref" (SourceRef.Committed/WorkingTree), column 7 is the correlated
    // records_committed EXISTS Search's SELECT list adds. None for the overwhelming majority (ref is
    // committed); Added/Modified only ever come from a row this ticket's own dirty-listing tests
    // produce. Kept out of ReadSummary's constructor call so the ref/snapshot→enum decision stays in
    // C#, not duplicated as SQL string literals ('modified'/'added') the reader would otherwise parse.
    private static WorkingTreeState ReadWorkingTreeState(DuckDBDataReader reader)
    {
        if (reader.GetString(6) != SourceRef.WorkingTree) return WorkingTreeState.None;
        return reader.GetBoolean(7) ? WorkingTreeState.Modified : WorkingTreeState.Added;
    }

    // The read-side mirror of AppendTyped: a column declared INTEGER read back an int no matter
    // whether its extractor produced a byte, ushort or uint, because the wide table's column type
    // did the narrowing. Reconstitution has no column to do it, so the same conversion is applied
    // here — without it a field's JSON would silently change numeric shape for every sub-int type.
    private static object? CoerceToColumnType(object? value, string duckDbType)
    {
        if (value == null) return null;
        return duckDbType switch
        {
            "BOOLEAN" => Convert.ToBoolean(value, CultureInfo.InvariantCulture),
            "INTEGER" => Convert.ToInt32(value, CultureInfo.InvariantCulture),
            "BIGINT" => Convert.ToInt64(value, CultureInfo.InvariantCulture),
            "FLOAT" => Convert.ToSingle(value, CultureInfo.InvariantCulture),
            "DOUBLE" => Convert.ToDouble(value, CultureInfo.InvariantCulture),
            "VARCHAR" => value.ToString(),
            _ => value,
        };
    }

    internal static string ColumnList(RecordTableSchema schema) =>
        schema.RecordColumns.Count == 0
            ? ""
            : ", " + string.Join(", ", schema.RecordColumns.Select(c => $"\"{c.Name}\""));

    // origin (#296 / ADR-0036): nullable and independent of plugin — a *filter*, not an identity
    // field. Defaults to "no
    // constraint" so a plugin-only or filter-less call keeps returning every origin's rows, same as
    // before this parameter existed.
    // recordTypes (#413): the single-table read model's replacement for "which table am I querying" —
    // an empty/null list means every type, one entry is what a per-type listing used to get from the
    // table name, and several is what SearchRecords used to get from a UNION ALL across tables.
    private static (string where, List<string> paramValues) BuildWhere(
        string? plugin, string? search, bool filterActive = false, string? origin = null,
        IReadOnlyList<string>? recordTypes = null)
    {
        var conditions = new List<string>();
        var values = new List<string>();

        if (recordTypes is { Count: > 0 })
        {
            var placeholders = recordTypes.Select((_, i) => $"${values.Count + i + 1}");
            conditions.Add($"record_type IN ({string.Join(", ", placeholders)})");
            values.AddRange(recordTypes.Select(NormalizeRecordType));
        }

        if (plugin != null)
        {
            conditions.Add($"plugin = ${values.Count + 1}");
            values.Add(plugin);
        }
        if (origin != null)
        {
            conditions.Add($"origin = ${values.Count + 1}");
            values.Add(origin);
        }
        if (search != null)
        {
            // Issue #210: a FormKey-shaped query (e.g. seeded by the picker from the record's own
            // reference, or pasted per #201) resolves directly against the exact stored form_key
            // rather than an EditorID substring match — form_key values are always stored via
            // Mutagen's own FormKey.ToString(), so round-tripping the query through
            // FormKey.TryFactory/.ToString() canonicalizes case/format to match. A query that merely
            // looks FormKey-ish but doesn't fully parse falls through to the EditorID match below,
            // same as always.
            if (Mutagen.Bethesda.Plugins.FormKey.TryFactory(search, out var formKey))
            {
                // Case-insensitive: FormKey.TryFactory canonicalizes the hex id but does not
                // re-case the ModKey (plugin) portion against known data, so a user-typed
                // lowercase plugin name would otherwise miss an exact case-sensitive match.
                conditions.Add($"LOWER(form_key) = LOWER(${values.Count + 1})");
                values.Add(formKey.ToString());
            }
            else
            {
                conditions.Add($"editor_id ILIKE ${values.Count + 1}");
                values.Add($"%{search}%");
            }
        }
        if (filterActive)
            conditions.Add("form_key IN (SELECT form_key FROM _filter)");

        var where = conditions.Count > 0 ? " WHERE " + string.Join(" AND ", conditions) : "";
        return (where, values);
    }

    // Record types used to be table names, and DuckDB resolves those case-insensitively — so callers
    // have always been free to say "NPC_" or "npc_" and several do. As a column value the comparison
    // is case-*sensitive*, which would silently return nothing for the same call that used to work.
    // Schema keys are produced by RecordType.Type.ToLowerInvariant(), so lowercasing the caller's
    // value is an exact normalization, not a guess. Applied at every point a caller-supplied type is
    // bound as a parameter.
    private static string NormalizeRecordType(string recordType) => recordType.ToLowerInvariant();

    private static bool IsHeaderTable(string tableName) =>
        string.Equals(tableName, HeaderIndexer.TableName, StringComparison.OrdinalIgnoreCase);


    private static void AddParams(DuckDBCommand cmd, IEnumerable<string> values)
    {
        foreach (var v in values)
            cmd.Parameters.Add(new DuckDBParameter { Value = v });
    }

    // #271/#272 / ADR-0036: scoped to (plugin, origin) together — reindexing one origin's plugin
    // must never delete another origin's rows for the same filename. Every reindexed table now
    // goes through this (the filename-only `DeleteExisting` predecessor was deleted once header,
    // #272's last holdout, moved to this method too — see IndexHeader below).
    private void DeleteExistingForOrigin(string tableName, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"DELETE FROM mirror.\"{tableName}\" WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    // #415: one form_references row, appended the same way whether it came from a whole-plugin ingest
    // or from a single record's working-tree change — extracted so the two paths cannot append
    // different column orders into the same table.
    private static void AppendFormReference(DuckDBAppender appender, FormRef r, string plugin, string origin)
    {
        var row = appender.CreateRow();
        row.AppendValue(r.SourceFormKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(r.TargetFormKey);
        row.AppendValue(r.FieldPath);
        row.AppendValue(r.RecordType);
        if (r.EditorId is { } eid)
            row.AppendValue(eid);
        else
            row.AppendNullValue();
        row.EndRow();
    }

    private void DeleteFormReferencesForPlugin(string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = "DELETE FROM mirror.form_references WHERE source_plugin = $1 AND source_origin = $2";
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        cmd.ExecuteNonQuery();
    }

    // One record's VMAD Object-property refs — the body of the loop above, extracted so #415's
    // per-record re-derivation walks VMAD through the identical code rather than a second copy of it.
    // The parameter is IMajorRecordGetter rather than the VMAD aspect interface because the
    // re-derivation path holds a record reconstituted from its document, and would otherwise have to
    // repeat the aspect test at its own call site. A record with no VMAD contributes nothing.
    private static void CollectVmadRefsForRecord(
        IMajorRecordGetter record, string recordType, List<FormRef> refs)
    {
        if (record is not IHaveVirtualMachineAdapterGetter { VirtualMachineAdapter: { } vmad }) return;

        var formKey = record.FormKey.ToString();
        foreach (var script in vmad.Scripts)
        {
            foreach (var property in script.Properties)
            {
                if (VmadCodec.Parse(property) is not { } parsed) continue;
                var propPath = $@"VMAD\{script.Name}\{property.Name}";
                foreach (var r in parsed.Refs)
                    refs.Add(new FormRef(formKey, r.FormKey, propPath + r.RelativePath, recordType, null));
            }
        }
    }

    // ADR-0023: populate the worldspace-tree side tables from the GRUP hierarchy that
    // EnumerateMajorRecords flattens away.
    private void IndexPlacement(IModGetter pluginMod, string plugin, string origin)
    {
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);

        using var cellAppender = Connection.CreateAppender("mirror", "cell_location");
        using var placeAppender = Connection.CreateAppender("mirror", "placement");

        _placementWalker.Walk(pluginMod,
            cell =>
            {
                var row = cellAppender.CreateRow();
                row.AppendValue(cell.CellFormKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                DuckDbAppend.Nullable(row, cell.ParentWorldspace);
                DuckDbAppend.Nullable(row, cell.BlockX);
                DuckDbAppend.Nullable(row, cell.BlockY);
                DuckDbAppend.Nullable(row, cell.SubX);
                DuckDbAppend.Nullable(row, cell.SubY);
                DuckDbAppend.Nullable(row, cell.GridX);
                DuckDbAppend.Nullable(row, cell.GridY);
                DuckDbAppend.Nullable(row, cell.IsInterior);
                row.EndRow();
            },
            placed =>
            {
                var row = placeAppender.CreateRow();
                row.AppendValue(placed.FormKey);
                row.AppendValue(plugin);
                row.AppendValue(origin);
                row.AppendValue(placed.ParentCell);
                row.AppendValue(placed.PlacementGroup);
                DuckDbAppend.Nullable(row, placed.PosX);
                DuckDbAppend.Nullable(row, placed.PosY);
                DuckDbAppend.Nullable(row, placed.PosZ);
                row.EndRow();
            });
    }

    // Issue #1 slice A1: header rows never flow through IndexRecordTable (see the Index() skip
    // above), so they need their own delete-then-append step, matching every other side table.
    // #271/#272 / ADR-0036: the header table's DDL comes from the same generic CreateRecordTable as
    // every reflected schema, so it carries the `origin` column too — HeaderIndexer.Index has
    // appended it since #271; the delete step below was #272's last remaining filename-only gap
    // (VMAD/conditions/form_lookup were migrated to DeleteExistingForOrigin earlier in this same
    // ticket) and is now scoped to (plugin, origin) here too.
    private void IndexHeader(
        IModGetter pluginMod, string plugin, string origin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (!schemas.TryGetValue("header", out var headerSchema)) return;

        DeleteExistingForOrigin("header", plugin, origin);
        using var appender = Connection.CreateAppender("mirror", "header");
        HeaderIndexer.Index(pluginMod, plugin, origin, headerSchema, appender);
    }

    // One record's condition refs — the body of the loop above, extracted so #415's per-record
    // re-derivation walks conditions through the identical code rather than a second copy of it.
    // Returns whether this record owns any conditions at all, which is what the caller's own
    // "indexed conditions for N records" count has always meant.
    private bool CollectConditionRefsForRecord(IMajorRecordGetter record, string recordType, List<FormRef> refs)
    {
        if (_conditionCodec == null) return false;

        var owners = _conditionCodec.Extract(record);
        if (!owners.Any()) return false;

        var formKey = record.FormKey.ToString();
        foreach (var owner in owners)
        {
            for (var ci = 0; ci < owner.Conditions.Count; ci++)
                CollectConditionRefsForOne(formKey, recordType, owner.FieldPath, ci, owner.Conditions[ci], refs);
        }

        return true;
    }

    // Mirrors the deleted ConditionIndexer.CollectConditionRefs: a condition's three FormKey-bearing
    // slots (a Form-category parameter, the Run-On reference, the Use-Global comparison target).
    // FieldPath format matches Edits/ConditionPath.Build/BuildParameter exactly (see that type and
    // the deleted ConditionIndexer's own comment for why this reproduces rather than imports it —
    // Records/ doesn't reference Edits/).
    private static void CollectConditionRefsForOne(
        string formKey, string recordType, string fieldPath, int index, ParsedCondition c, List<FormRef> refs)
    {
        if (c.RunOnTarget == "Reference" && c.RunOnReference is { Length: > 0 } runOnRef)
            refs.Add(new FormRef(formKey, runOnRef, ConditionSubFieldPath(fieldPath, index, "RunOn"), recordType, null));

        if (c.UseGlobal && c.ComparisonGlobal is { Length: > 0 } comparisonGlobal)
            refs.Add(new FormRef(formKey, comparisonGlobal, ConditionSubFieldPath(fieldPath, index, "Comparison"), recordType, null));

        for (var pi = 0; pi < c.Parameters.Count; pi++)
        {
            var param = c.Parameters[pi];
            if (param.Category == ConditionParamCategory.Form && param.FormKey is { Length: > 0 } paramFormKey)
                refs.Add(new FormRef(
                    formKey, paramFormKey, ConditionSubFieldPath(fieldPath, index, $@"Parameter\{pi}"), recordType, null));
        }
    }

    private static string ConditionSubFieldPath(string fieldPath, int index, string subField) =>
        $@"CTDA\{fieldPath}\{index}\{subField}";

    private static void CollectFormRefs(
        List<FormRef> refs,
        IMajorRecordGetter record,
        string tableName,
        RecordTableSchema schema)
    {
        var sourceFormKey = record.FormKey.ToString();
        var sourceEditorId = record.EditorID;
        foreach (var col in schema.RecordColumns)
        {
            FormRefPathBuilder.Walk(col, c => c.Extract(record), (path, fk) =>
                refs.Add(new FormRef(sourceFormKey, fk, path, tableName, sourceEditorId)));
        }
    }


    private void Execute(string sql)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    internal static void AppendTyped(IDuckDBAppenderRow row, object? value, string duckDbType)
    {
        if (value == null) { row.AppendNullValue(); return; }
        switch (duckDbType)
        {
            case "BOOLEAN": row.AppendValue((bool?)Convert.ToBoolean(value, CultureInfo.InvariantCulture)); break;
            case "INTEGER": row.AppendValue((int?)Convert.ToInt32(value, CultureInfo.InvariantCulture)); break;
            case "BIGINT": row.AppendValue((long?)Convert.ToInt64(value, CultureInfo.InvariantCulture)); break;
            case "FLOAT": row.AppendValue((float?)Convert.ToSingle(value, CultureInfo.InvariantCulture)); break;
            case "DOUBLE": row.AppendValue((double?)Convert.ToDouble(value, CultureInfo.InvariantCulture)); break;
            case "VARCHAR": row.AppendValue(value.ToString()); break;
        }
    }

    private IReadOnlyDictionary<string, RecordTableSchema> RequireSchemas() =>
        _schemas ?? throw new InvalidOperationException("Call Initialize before using the repository.");

    // #421: private — GetReferencedBy(string) above is the public seam member and delegates here.
    private List<ReferenceResult> GetReferences(string targetFormKey)
    {
        // ADR-0041: committed references only. The read overlay this query used to carry
        // (subtracting references an uncommitted edit had superseded, then unioning that edit's own
        // references back in) is retired — a reference is what the indexed
        // plugin actually declares.
        const string sql = """
            SELECT fr.source_form_key, fr.source_plugin, fr.field_path, fr.record_type, fr.editor_id, fr.source_origin
            FROM form_references fr
            WHERE fr.target_form_key = $1
            """;

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = sql;
        AddParams(cmd, [targetFormKey]);

        var results = new List<ReferenceResult>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            results.Add(new ReferenceResult(
                reader.GetString(0),
                reader.GetString(1),
                reader.GetString(2),
                reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(5)));
        }

        return results;
    }

    // ── Worldspace tree reads (ADR-0023) ────────────────────────────────────────

    public IReadOnlyList<CellLocationSummary> GetWorldspaceCells(PluginKey plugin, string worldspaceFormKey) =>
        GetWorldspaceCells(EffectiveRelation, plugin.Name, worldspaceFormKey, plugin.Origin!);

    // #421: private — GetWorldspaceCells(PluginKey, string) above is the public seam member.
    private List<CellLocationSummary> GetWorldspaceCells(string records, string plugin, string worldspaceFormKey, string origin)
    {
        using var cmd = Connection.CreateCommand();
        // #497: full_name is read straight out of the joined row's own JSON body rather than a
        // stored column the way editor_id is — this is the only consumer today, c.body is already
        // in scope on every relation {records} resolves to, and promoting it to a stored column
        // (mirroring editor_id's INSERT/UPDATE plumbing across every working-tree write path) is
        // easy to do later if a second consumer ever needs it. '$.Name.Value' is what the codec
        // emits for an *unlocalized* plugin's FULL subrecord (Mutagen's TranslatedString with a
        // direct string) — a localized plugin (STRINGS-backed, e.g. an official master) serializes
        // to '$.Name.Values' (a per-language array) instead, which this misses; the FULL name then
        // reads as absent and this falls back to the grid/EditorID label, same as a cell with no
        // FULL name at all, rather than surfacing the wrong string.
        cmd.CommandText = $"""
            SELECT cl.cell_form_key, c.editor_id, cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y,
                   json_extract_string(c.body, '$.Name.Value')
            FROM cell_location cl
            LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.parent_worldspace = $1 AND cl.plugin = $2 AND cl.origin = $3
            ORDER BY cl.block_x, cl.block_y, cl.sub_x, cl.sub_y, cl.grid_x, cl.grid_y
            """;
        AddParams(cmd, [worldspaceFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        var rows = new List<CellLocationSummary>();
        while (reader.Read())
        {
            rows.Add(new CellLocationSummary(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetInt32(2),
                reader.IsDBNull(3) ? null : reader.GetInt32(3),
                reader.IsDBNull(4) ? null : reader.GetInt32(4),
                reader.IsDBNull(5) ? null : reader.GetInt32(5),
                reader.IsDBNull(6) ? null : reader.GetInt32(6),
                reader.IsDBNull(7) ? null : reader.GetInt32(7),
                reader.IsDBNull(8) ? null : reader.GetString(8)));
        }

        return rows;
    }

    public PagedResult<CellSummary> GetInteriorCells(PluginKey plugin, int limit, int offset) =>
        GetInteriorCells(EffectiveRelation, plugin.Name, limit, offset, plugin.Origin!);

    // #421: private — GetInteriorCells(PluginKey, int, int) above is the public seam member.
    private PagedResult<CellSummary> GetInteriorCells(string records, string plugin, int limit, int offset, string origin)
    {
        using var countCmd = Connection.CreateCommand();
        countCmd.CommandText = "SELECT COUNT(*) FROM cell_location WHERE is_interior AND plugin = $1 AND origin = $2";
        countCmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        countCmd.Parameters.Add(new DuckDBParameter { Value = origin });
        var total = (long)countCmd.ExecuteScalar()!;

        // #458: same non-unique-ordering shape as Search's above — c.editor_id alone gives DuckDB no
        // tiebreak for LIMIT/OFFSET paging, so ties can land on either side of a page boundary
        // differently across calls. The WHERE clause already scopes this query to one plugin+origin,
        // so cl.cell_form_key alone (cell_location's own identity within that scope) is a sufficient
        // tiebreak — no need to repeat the already-constant plugin/origin columns.
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT cl.cell_form_key, c.editor_id, cl.grid_x, cl.grid_y
            FROM cell_location cl
            LEFT JOIN {records} c ON c.form_key = cl.cell_form_key AND c.plugin = cl.plugin AND c.origin = cl.origin
            WHERE cl.is_interior AND cl.plugin = $1 AND cl.origin = $2
            ORDER BY c.editor_id, cl.cell_form_key
            LIMIT {limit} OFFSET {offset}
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = origin });
        using var reader = cmd.ExecuteReader();

        var items = new List<CellSummary>();
        while (reader.Read())
        {
            items.Add(new CellSummary(
                reader.GetString(0),
                reader.IsDBNull(1) ? null : reader.GetString(1),
                reader.IsDBNull(2) ? null : reader.GetInt32(2),
                reader.IsDBNull(3) ? null : reader.GetInt32(3)));
        }

        return new PagedResult<CellSummary>(items, (int)total);
    }

    public CellReferences GetCellReferences(PluginKey plugin, string cellFormKey) =>
        GetCellReferences(EffectiveRelation, plugin.Name, cellFormKey, plugin.Origin!);

    // #421: private — GetCellReferences(PluginKey, string) above is the public seam member.
    private CellReferences GetCellReferences(string records, string plugin, string cellFormKey, string origin)
    {
        var schemas = RequireSchemas();
        var placedTypes = PlacedTableNames.Where(schemas.ContainsKey).ToList();
        if (placedTypes.Count == 0)
            return new CellReferences([], []);

        // ADR-0041 / #413: one single-table query where this used to UNION a wide table per placed
        // type — the record_type column is what the union was standing in for. The placed ref's base
        // form comes out of the document rather than a `base` column; json_extract_string unquotes
        // the stored FormLink text, and a placed ref with no base at all reads NULL exactly as the
        // wide column did (RealDataReadGoldenTests.SpatialReads_MatchGolden pins both shapes).
        var typeList = string.Join(", ", placedTypes.Select(t => $"'{t}'"));

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"""
            SELECT p.placement_group, r.record_type, p.form_key, r.editor_id,
                   json_extract_string(r.body, '$.Base')
            FROM placement p
            JOIN {records} r ON r.form_key = p.form_key AND r.plugin = p.plugin AND r.origin = p.origin
            WHERE p.parent_cell = $1 AND p.plugin = $2 AND p.origin = $3
              AND r.record_type IN ({typeList})
            ORDER BY r.editor_id
            """;
        AddParams(cmd, [cellFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        var persistent = new List<PlacedSummary>();
        var temporary = new List<PlacedSummary>();
        while (reader.Read())
        {
            var group = reader.GetString(0);
            var summary = new PlacedSummary(
                reader.GetString(2),
                reader.IsDBNull(3) ? null : reader.GetString(3),
                reader.IsDBNull(4) ? null : reader.GetString(4),
                reader.GetString(1));
            (group == "persistent" ? persistent : temporary).Add(summary);
        }
        return new CellReferences(persistent, temporary);
    }

    public PlacementRow? GetPlacement(string formKey, PluginKey plugin) =>
        GetPlacement(formKey, plugin.Name, plugin.Origin!);

    // origin (#272 / ADR-0036, required since #275): same reasoning as Index's.
    // #421: private — GetPlacement(string, PluginKey) above is the public seam member.
    private PlacementRow? GetPlacement(string formKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_cell, placement_group, pos_x, pos_y, pos_z
            FROM placement
            WHERE form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [formKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        // Local function so the merged conditional expression below doesn't nest a ternary per
        // coordinate (SonarS3358) while still collapsing the guard clause per IDE0046.
        float? NullableFloat(int i) => reader.IsDBNull(i) ? null : reader.GetFloat(i);

        return !reader.Read()
            ? null
            : new PlacementRow(
                formKey,
                reader.GetString(0),
                reader.GetString(1),
                NullableFloat(2),
                NullableFloat(3),
                NullableFloat(4));
    }

    public CellLocationRow? GetCellLocation(PluginKey plugin, string cellFormKey) =>
        GetCellLocation(cellFormKey, plugin.Name, plugin.Origin!);

    // #416 S1b: mirrors GetPlacement's shape exactly — same ref-invariance, same reasoning.
    private CellLocationRow? GetCellLocation(string cellFormKey, string plugin, string origin)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_worldspace, block_x, block_y, sub_x, sub_y, grid_x, grid_y, is_interior
            FROM cell_location
            WHERE cell_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [cellFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        int? NullableInt(int i) => reader.IsDBNull(i) ? null : reader.GetInt32(i);
        if (!reader.Read()) return null;

        var parentWorldspace = reader.IsDBNull(0) ? null : reader.GetString(0);
        return new CellLocationRow(
            cellFormKey, parentWorldspace,
            NullableInt(1), NullableInt(2), NullableInt(3), NullableInt(4), NullableInt(5), NullableInt(6),
            reader.GetBoolean(7));
    }

    public IReadOnlyList<ContainerChildRow> GetContainerChildren(PluginKey plugin, string parentFormKey) =>
        GetContainerChildren(plugin.Name, plugin.Origin!, parentFormKey);

    // Ref-invariant (see ContainerChildRow's own doc comment) — same reasoning as GetPlacement, so
    // this ignores which relation the caller is positioned on, exactly as GetPlacement does.
    private List<ContainerChildRow> GetContainerChildren(string plugin, string origin, string parentFormKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT child_form_key, parent_record_type, slot_name, slot_index
            FROM container_child
            WHERE parent_form_key = $1 AND plugin = $2 AND origin = $3
            ORDER BY slot_name, slot_index
            """;
        AddParams(cmd, [parentFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        var result = new List<ContainerChildRow>();
        while (reader.Read())
        {
            result.Add(new ContainerChildRow(
                reader.GetString(0), parentFormKey, reader.GetString(1), reader.GetString(2), reader.GetInt32(3)));
        }
        return result;
    }

    /// <summary>See <see cref="IRecordReads.GetContainerParent"/>. Ref-invariant for the same reason
    /// its inverse is, so it likewise ignores which relation the caller is positioned on.</summary>
    public ContainerChildRow? GetContainerParent(PluginKey plugin, string childFormKey) =>
        GetContainerParent(plugin.Name, plugin.Origin!, childFormKey);

    private ContainerChildRow? GetContainerParent(string plugin, string origin, string childFormKey)
    {
        using var cmd = Connection.CreateCommand();
        cmd.CommandText = """
            SELECT parent_form_key, parent_record_type, slot_name, slot_index
            FROM container_child
            WHERE child_form_key = $1 AND plugin = $2 AND origin = $3
            """;
        AddParams(cmd, [childFormKey, plugin, origin]);
        using var reader = cmd.ExecuteReader();

        return reader.Read()
            ? new ContainerChildRow(
                childFormKey, reader.GetString(0), reader.GetString(1), reader.GetString(2), reader.GetInt32(3))
            : null;
    }

    public IReadOnlySet<string> GetPluginsWithMatchingRecords(IEnumerable<string> tableNames) =>
        GetPluginsWithMatchingRecords(EffectiveRelation, tableNames);

    private HashSet<string> GetPluginsWithMatchingRecords(string records, IEnumerable<string> tableNames)
    {
        var types = tableNames.ToList();
        if (types.Count == 0 || !_filterActive)
            return new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        // #413: third union shape collapsed — see SearchRecords.
        var (where, paramValues) = BuildWhere(null, null, filterActive: true, origin: null, recordTypes: types);

        using var cmd = Connection.CreateCommand();
        cmd.CommandText = $"SELECT DISTINCT plugin FROM {records}{where}";
        AddParams(cmd, paramValues);
        using var reader = cmd.ExecuteReader();

        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        while (reader.Read())
            result.Add(reader.GetString(0));
        return result;
    }

    /// <summary>See <see cref="IRecordIndex.ReplaceContainerChildSlot"/>.</summary>
    public void ReplaceContainerChildSlot(
        PluginKey key, string parentFormKey, string parentRecordType, string slotName,
        IReadOnlyList<(string ChildFormKey, int SlotIndex)> children)
    {
        ExecuteFor(
            """
            DELETE FROM mirror.container_child
            WHERE parent_form_key = $1 AND slot_name = $2 AND plugin = $3 AND origin = $4
            """,
            parentFormKey, slotName, key.Name, key.Origin!);

        if (children.Count == 0) return;

        using var appender = Connection.CreateAppender("mirror", "container_child");
        foreach (var (childFormKey, slotIndex) in children)
        {
            AppendContainerChildRow(
                appender,
                new ContainerChildRow(childFormKey, parentFormKey, parentRecordType, slotName, slotIndex),
                key.Name, key.Origin!);
        }
    }

    /// <summary>See <see cref="IRecordIndex.RepointContainerChildParent"/>.</summary>
    public void RepointContainerChildParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        ExecuteFor(
            """
            UPDATE mirror.container_child SET parent_form_key = $1
            WHERE parent_form_key = $2 AND plugin = $3 AND origin = $4
            """,
            newParentFormKey, oldParentFormKey, key.Name, key.Origin!);

    /// <summary>See <see cref="IRecordIndex.RepointCellLocationParent"/>.</summary>
    public void RepointCellLocationParent(PluginKey key, string oldParentFormKey, string newParentFormKey) =>
        ExecuteFor(
            """
            UPDATE mirror.cell_location SET parent_worldspace = $1
            WHERE parent_worldspace = $2 AND plugin = $3 AND origin = $4
            """,
            newParentFormKey, oldParentFormKey, key.Name, key.Origin!);

    public void SetFilter(string? sql)
    {
        if (sql is null)
        {
            _filterActive = false;
            return;
        }

        using var probeCmd = Connection.CreateCommand();
        probeCmd.CommandText = $"SELECT * FROM ({sql}) __probe LIMIT 0";
        using var probeReader = probeCmd.ExecuteReader();
        bool hasFormKey = Enumerable.Range(0, probeReader.FieldCount)
            .Any(i => string.Equals(probeReader.GetName(i), "form_key", StringComparison.OrdinalIgnoreCase));

        if (!hasFormKey)
            throw new ArgumentException("Filter SQL must return a form_key column");

        Execute($"CREATE OR REPLACE TABLE _filter AS ({sql})");
        _filterActive = true;
    }

    public void Dispose() => Connection.Dispose();
}
