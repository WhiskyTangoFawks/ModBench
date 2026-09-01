using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// The prepare/append/collectors collaborator of
/// <see cref="DuckDbRecordIndex"/> — everything <see cref="IRecordIndex.Index"/>/
/// <see cref="IRecordIndex.Unindex"/> do to a plugin's own rows across every ingest-owned table
/// (<c>records</c>/<c>records_committed</c>/<c>form_lookup</c>/<c>form_references</c>/
/// <c>placement</c>/<c>cell_location</c>/<c>container_child</c>), plus the record-level collectors
/// (<see cref="CollectFormRefs"/>/<see cref="CollectVmadRefsForRecord"/>/
/// <see cref="CollectConditionRefsForRecord"/>) and append primitives <see cref="WorkingTreeOverlay"/>
/// reuses for per-record rederivation — that reuse is deliberate: an edit's derived rows
/// must come from the identical code a fresh ingest would produce them with, or the two could drift
/// apart. Internal, private to the <c>Records</c> module — not part of any public seam.
///
/// <para><b>Does not own registration or the transaction/commit boundary.</b>
/// <see cref="DuckDbRecordIndex.Index"/> owns the whole-reindex transaction and the
/// <c>records</c>-table appender's lifetime (so its disposal keeps the required ordering relative
/// to <c>tx.Commit()</c>), calling <see cref="IndexPlugin"/> for everything in
/// between. <see cref="DuckDbRecordIndex.Unindex"/> likewise owns the transaction, calling
/// <see cref="DeleteAllRowsFor"/> for the ingest-owned half and handling the file stamp
/// (<see cref="IndexStore"/>) and the registration row itself.</para>
/// </summary>
internal sealed class PluginIngest
{
    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly RecordTextCodec _codec;
    private readonly PlacementWalker _placementWalker;
    private readonly IConditionCodec? _conditionCodec;

    public PluginIngest(
        DuckDBConnection connection, ILogger logger, RecordTextCodec codec,
        PlacementWalker placementWalker, IConditionCodec? conditionCodec)
    {
        _connection = connection;
        _logger = logger;
        _codec = codec;
        _placementWalker = placementWalker;
        _conditionCodec = conditionCodec;
    }

    /// <summary>The per-plugin phase timings <see cref="DuckDbRecordIndex.Index"/> logs.</summary>
    internal readonly record struct IndexTiming(long DocumentsMs, long PrepareMs, long AppendMs, long ExtractedMs);

    // Cell.Persistent/Temporary and Worldspace.TopCell/SubCells are already fully covered
    // by IndexPlacement (placement/cell_location) — this skip-list keeps container_child additive to
    // those tables rather than a second, competing copy of the same relationship. Keyed by
    // ContainerChildFields.NormalizedTypeName so it can never drift from what EnumerateChildren
    // itself walks (both read the same ByTypeName table). Internal: WorkingTreeOverlay's own
    // per-record rederivation walks the identical skip-list (Overlay depends on Ingest, never the
    // reverse).
    internal static readonly HashSet<(string ParentType, string Slot)> CoveredByPlacementTables =
    [
        ("Cell", "Persistent"), ("Cell", "Temporary"),
        ("Worldspace", "TopCell"), ("Worldspace", "SubCells"),
    ];

    /// <summary>Everything about one record that the index derives from the record itself, computed
    /// off the appender thread: the document bytes and their git-blob hash, the extracted
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

    // ADR-0041: this plugin's documents go first, for the same reason every other table's
    // delete does — a re-index replaces its own rows rather than accumulating a second copy.
    // This covers the plugin header's row too (#631): it is an ordinary `records` row, so the one
    // delete here is also its delete, and HeaderIndexer needs no step of its own.
    //
    // Its own method, called by DuckDbRecordIndex.Index *before* it creates the `records` appender
    // and calls IndexPlugin below — the deletes must precede the appender's creation rather than
    // resting on an unverified assumption about how DuckDB's appender behaves relative to a delete
    // issued after it exists.
    public void DeletePriorDocuments(string plugin, string origin)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        // And the Head snapshots with them. `records_head` is records_committed UNION ALL the
        // still-clean `records` rows, and those halves must stay disjoint (TableDdlBuilder says so "by
        // construction" and its UNION ALL — not UNION — depends on it exactly). Re-seeding `records`
        // while leaving a snapshot behind puts two rows under one (form_key, plugin, origin) at Head.
        //
        // Part of Index()'s own stated contract — "replacing whatever `key` previously held".
        // SourceIngest.Ingest (its binary fallback) and LoadOrderMirror.ReindexPlugin re-reading a
        // binary under a dirty tracked plugin both call Index() and write records_committed for the
        // same key; deleting here rather than at either call site is what makes every present and
        // future caller inherit it. Never removes a *correct* snapshot: after a full re-index from
        // one source, a prior divergence describes bytes that no longer relate to what was just
        // ingested.
        DeleteExistingForOrigin("records_committed", plugin, origin);
    }

    // ADR-0041: one document per major record, written from the same enumeration that fills
    // the record's own row — never a second pass over the plugin. The appender is opened once per
    // Index() call (by DuckDbRecordIndex, which owns its lifetime — see this class's own doc
    // comment) and threaded through the per-type loop below, because `records` is one table
    // spanning every type. Callers must run
    // DeletePriorDocuments above first — this method does not repeat those two deletes.
    public IndexTiming IndexPlugin(
        IModGetter pluginMod, string plugin, string origin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, DuckDBAppender documentAppender)
    {
        var refs = new List<FormRef>();
        var lookupRows = new List<(string FormKey, string RecordType, string? EditorId)>();
        var containerChildRows = new List<ContainerChildRow>();

        if (_conditionCodec == null)
        {
            _logger.LogWarning("No condition codec for {Game}; skipping condition refs for {Plugin}",
                pluginMod.GameRelease, plugin);
        }

        var phaseTimer = Stopwatch.StartNew();
        var counters = new RefCounters();
        foreach (var (tableName, schema) in schemas)
        {
            // The header is never a major-record type (ModHeader has no FormKey/EditorID) —
            // IndexRecordTable's EnumerateMajorRecords call assumes one, so it is appended separately
            // by IndexHeader below. Its row lands in `records` like every other one (#631); only the
            // way it is *reached* differs, because Mutagen's own enumeration cannot reach it.
            if (tableName == HeaderIndexer.RecordType) continue;
            IndexRecordTable(
                tableName, schema, pluginMod, plugin, origin, refs, lookupRows,
                containerChildRows, documentAppender, pluginMod.GameRelease, counters);
        }
        var documentsMs = phaseTimer.ElapsedMilliseconds;

        // RecordIndexingLoggingTests pins these summary texts/levels; the counts come from the one
        // pass above.
        if (_logger.IsEnabled(LogLevel.Debug))
        {
            _logger.LogDebug("Indexed VMAD for {Count} records in {Plugin}", counters.Vmad, plugin);
            _logger.LogDebug("Indexed conditions for {Count} records in {Plugin}", counters.Conditions, plugin);
        }

        // VMAD and condition refs are collected inside IndexRecordTable's one pass, walking the live
        // object rather than round-tripping through the document that pass just wrote, so both the
        // generic and the VMAD Object refs land in the shared list before the single form_references
        // flush below, while GetVmad and GetConditions read the document on demand. What that pass
        // does not see is exactly what has no schema (SchemaReflector.ExcludedTables — the placed
        // projectile types): those records have no document and no row, and contribute no
        // VMAD/condition refs either.

        phaseTimer.Restart();
        IndexPlacement(pluginMod, plugin, origin);

        // Before the form_lookup flush below, deliberately: the header's row and its lookup row are
        // written by the same two flushes as every other record's, which is what keeps ADR-0031's
        // one-lookup-row-per-record-row invariant true by construction rather than by a second sweep.
        if (schemas.ContainsKey(HeaderIndexer.RecordType))
            lookupRows.Add(HeaderIndexer.Index(pluginMod, plugin, origin, documentAppender));

        // Clear this plugin's stale refs, then rebuild from the refs gathered across both passes.
        DeleteFormReferencesForPlugin(plugin, origin);
        if (refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                AppendFormReference(refAppender, r, plugin, origin);
        }

        // ADR-0031: one form_lookup row per indexed record, populated in this same pass — no
        // second indexing pass over the plugin.
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        if (lookupRows.Count > 0)
        {
            using var lookupAppender = _connection.CreateAppender("mirror", "form_lookup");
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

        // Same pattern as form_lookup just above — one delete-then-append per re-index,
        // populated from the same per-type pass rather than a second walk over the plugin.
        DeleteExistingForOrigin("container_child", plugin, origin);
        if (containerChildRows.Count > 0)
        {
            using var containerChildAppender = _connection.CreateAppender("mirror", "container_child");
            foreach (var row in containerChildRows)
                AppendContainerChildRow(containerChildAppender, row, plugin, origin);
        }

        var extractedMs = phaseTimer.ElapsedMilliseconds;
        return new IndexTiming(documentsMs, counters.PrepareMs, counters.AppendMs, extractedMs);
    }

    // The inverse of IndexPlugin, table for table — deliberately built from the same per-plugin
    // delete helper IndexPlugin itself calls before each append, so a new indexed table cannot be
    // added to one side without the other noticing (they are the same calls).
    // DuckDbRecordIndex.Unindex calls this for the ingest-owned half, then handles the file stamp
    // (IndexStore) and the registration row itself — see this class's own doc comment.
    public void DeleteAllRowsFor(string plugin, string origin)
    {
        // Every record row is in `records`, the plugin header's included (#631 — no per-type table
        // survives). Deleting this plugin's `records` rows also removes the one thing
        // GetVmad/GetConditions read.
        DeleteExistingForOrigin("records", plugin, origin);
        // "Removes every trace of key" has to include the Head side. A leftover snapshot would
        // keep answering at Head for a plugin the load order no longer holds — the exact opposite of
        // ADR-0035's "hidden means absent".
        DeleteExistingForOrigin("records_committed", plugin, origin);
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        DeleteFormReferencesForPlugin(plugin, origin);
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);
        DeleteExistingForOrigin("container_child", plugin, origin);
    }

    // Blocking on the codec's async path is deliberate rather than an oversight: serialization runs
    // entirely over a MemoryStream with no IO (RecordTextCodec.SerializeToBytesAsync), so there is
    // nothing to await on. The async signature comes from Mutagen's generated serializers, and
    // making Index() async to match would push a false IO-bound shape up through IRecordIndex into
    // LoadOrderMirror's indexing loop for no benefit.
    private PreparedRecord PrepareRecord(
        IMajorRecordGetter record, string recordType, RecordTableSchema schema, GameRelease gameRelease)
    {
        // A container's children get a recorded parent slot, for the relationships
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

        // Every record is serialized straight from the getter ingest already holds, container or
        // not: a container's document carries its embedded children, because that is what its
        // source file holds — the whole point of one document shape (ADR-0041). A tracked plugin
        // ingests from its source tree, where an embedded child has no separate file to diverge
        // from, and compile deserializes the tree whole, so a container's children come from the
        // one document that holds them. Do not add a reconciliation pass between inline copies and
        // separate child files; that is the shape ADR-0041's amendment exists to delete.
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

        // ADR-0041: this loop's whole
        // output is one document per record plus the extracted index rows derived from it — the
        // per-type enumeration survives only because it is how a record's type is known.
        //
        // The per-record work is CPU-bound and independent record to record — serialize,
        // hash, the form-ref walk, container children, VMAD and condition refs — measured at 98% of
        // a full load order's load on one core of eight. It runs in parallel here; only the appender
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
                    // RecordIndexingLoggingTests pins these per-record trace texts.
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

    /// <summary>Records prepared in parallel ahead of the appender at a time. Large enough
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

    // ADR-0023: populate the worldspace-tree side tables from the GRUP hierarchy that
    // EnumerateMajorRecords flattens away.
    private void IndexPlacement(IModGetter pluginMod, string plugin, string origin)
    {
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);

        using var cellAppender = _connection.CreateAppender("mirror", "cell_location");
        using var placeAppender = _connection.CreateAppender("mirror", "placement");

        _placementWalker.Walk(pluginMod,
            cell => AppendCellLocationRow(cellAppender, cell, plugin, origin),
            placed => AppendPlacementRow(placeAppender, placed, plugin, origin));
    }

    // One record's condition refs — the body of the loop above, extracted so per-record
    // re-derivation walks conditions through the identical code rather than a second copy of it.
    // Returns whether this record owns any conditions at all, which is what the caller's own
    // "indexed conditions for N records" count has always meant. Internal: WorkingTreeOverlay's own
    // per-record rederivation calls this through its PluginIngest reference (Overlay depends on
    // Ingest, never the reverse).
    internal bool CollectConditionRefsForRecord(IMajorRecordGetter record, string recordType, List<FormRef> refs)
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

    // A condition's three FormKey-bearing
    // slots (a Form-category parameter, the Run-On reference, the Use-Global comparison target).
    // FieldPath format matches Edits/ConditionPath.Build/BuildParameter exactly — reproduced rather
    // than imported because Records/ doesn't reference Edits/.
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

    // Internal: WorkingTreeOverlay's own per-record rederivation calls this through its PluginIngest
    // reference (Overlay depends on Ingest, never the reverse).
    internal static void CollectFormRefs(
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

    // One record's VMAD Object-property refs — the body of the loop above, extracted so
    // per-record re-derivation walks VMAD through the identical code rather than a second copy of it.
    // The parameter is IMajorRecordGetter rather than the VMAD aspect interface because the
    // re-derivation path holds a record reconstituted from its document, and would otherwise have to
    // repeat the aspect test at its own call site. A record with no VMAD contributes nothing.
    // Internal: WorkingTreeOverlay's own per-record rederivation calls this through its PluginIngest
    // reference (Overlay depends on Ingest, never the reverse).
    internal static void CollectVmadRefsForRecord(
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

    // One form_references row, appended the same way whether it came from a whole-plugin ingest
    // or from a single record's working-tree change — extracted so the two paths cannot append
    // different column orders into the same table. Internal: WorkingTreeOverlay's own per-record
    // rederivation calls this through its PluginIngest reference.
    internal static void AppendFormReference(DuckDBAppender appender, FormRef r, string plugin, string origin)
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

    private void DeleteFormReferencesForPlugin(string plugin, string origin) =>
        DuckDbSql.ExecuteFor(_connection,
            "DELETE FROM mirror.form_references WHERE source_plugin = $1 AND source_origin = $2", plugin, origin);

    // ADR-0036: scoped to (plugin, origin) together — reindexing one origin's plugin
    // must never delete another origin's rows for the same filename. Every reindexed table
    // goes through this.
    private void DeleteExistingForOrigin(string tableName, string plugin, string origin) =>
        DuckDbSql.ExecuteFor(_connection, $"DELETE FROM mirror.\"{tableName}\" WHERE plugin = $1 AND origin = $2", plugin, origin);

    // These three append primitives are used by both
    // WorkingTreeOverlay's per-record rederivation and DuckDbRecordIndex's own container-verb tail
    // (ReplaceContainerChildSlot/CreateCellLocation), which stays outside the three named
    // collaborators — "append" primitives belong with PluginIngest either way.
    internal static void AppendContainerChildRow(DuckDBAppender appender, ContainerChildRow row, string plugin, string origin)
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

    internal static void AppendPlacementRow(DuckDBAppender appender, PlacementRow row, string plugin, string origin)
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

    internal static void AppendCellLocationRow(DuckDBAppender appender, CellLocationRow row, string plugin, string origin)
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
}
