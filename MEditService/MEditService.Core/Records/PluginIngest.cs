using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>The prepare/append/collectors collaborator of <see cref="DuckDbRecordIndex"/>, which
/// owns the transaction. <c>WorkingTreeOverlay</c> reuses the collectors so an edit's derived rows
/// come from the same code a fresh ingest uses.</summary>
internal sealed class PluginIngest
{
    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly RecordTextCodec _codec;
    private readonly PlacementWalker _placementWalker;

    public PluginIngest(
        DuckDBConnection connection, ILogger logger, RecordTextCodec codec,
        PlacementWalker placementWalker)
    {
        _connection = connection;
        _logger = logger;
        _codec = codec;
        _placementWalker = placementWalker;
    }

    internal readonly record struct IndexTiming(long DocumentsMs, long PrepareMs, long AppendMs, long ExtractedMs);

    // Cell.Persistent/Temporary and Worldspace.TopCell/SubCells are already covered by
    // placement/cell_location; this skip-list keeps container_child additive. Keyed by
    // ContainerChildFields.NormalizedTypeName so it cannot drift from what EnumerateChildren walks.
    internal static readonly HashSet<(string ParentType, string Slot)> CoveredByPlacementTables =
    [
        ("Cell", "Persistent"), ("Cell", "Temporary"),
        ("Worldspace", "TopCell"), ("Worldspace", "SubCells"),
    ];

    // Everything the index derives from one record, computed off the appender thread; only writing
    // it is sequential. ParseDiagnosis is null for a record whose document was produced.
    private sealed record PreparedRecord(
        IMajorRecordGetter Record, byte[] Body, string ContentHash, List<FormRef> Refs,
        List<ContainerChildRow> ChildRows, string? EditorId, string? ParseDiagnosis);

    private sealed class RefCounters
    {
        public long PrepareMs;
        public long AppendMs;
    }

    // ADR-0041: a re-index replaces its own rows, the header's included. Called before
    // DuckDbRecordIndex.Index creates the appender rather than resting on an unverified assumption
    // about how an appender behaves relative to a later delete.
    public void DeletePriorDocuments(string plugin, string origin)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        // The Head snapshots go too: records_head is records_committed UNION ALL the still-clean
        // records rows, and the halves must stay disjoint. Deleting here rather than at each caller
        // is what makes every caller inherit it.
        DeleteExistingForOrigin("records_committed", plugin, origin);
    }

    // ADR-0041: one document per major record, from the same enumeration that fills its row. The
    // appender is opened once per Index() call because `records` is one table spanning every type.
    // DeletePriorDocuments must run first.
    public IndexTiming IndexPlugin(
        IModGetter pluginMod, string plugin, string origin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, DuckDBAppender documentAppender)
    {
        var refs = new List<FormRef>();
        var lookupRows = new List<(string FormKey, string RecordType, string? EditorId)>();
        var containerChildRows = new List<ContainerChildRow>();

        var phaseTimer = Stopwatch.StartNew();
        var counters = new RefCounters();
        foreach (var (tableName, schema) in schemas)
        {
            // The header is never a major-record type (no FormKey/EditorID), so EnumerateMajorRecords
            // cannot reach it; HeaderIndexer.Index appends it separately below.
            if (tableName == HeaderIndexer.RecordType) continue;
            IndexRecordTable(
                tableName, schema, pluginMod, plugin, origin, refs, lookupRows,
                containerChildRows, documentAppender, pluginMod.GameRelease, counters);
        }
        var documentsMs = phaseTimer.ElapsedMilliseconds;

        // Refs are collected in IndexRecordTable's one pass, walking the live object rather than the
        // document it just wrote. What that pass does not see is what has no schema
        // (SchemaReflector.ExcludedTables): no document, no row, no refs.

        phaseTimer.Restart();
        IndexPlacement(pluginMod, plugin, origin);

        // Before the form_lookup flush, so the header's row and lookup row go through the same two
        // flushes as every record's (ADR-0031: one lookup row per record row, by construction).
        if (schemas.ContainsKey(HeaderIndexer.RecordType))
            lookupRows.Add(HeaderIndexer.Index(pluginMod, plugin, origin, documentAppender));

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

    // The inverse of IndexPlugin, table for table, built from the same per-plugin delete helper so a
    // new indexed table cannot be added to one side without the other noticing.
    public void DeleteAllRowsFor(string plugin, string origin)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        // A leftover snapshot would keep answering at Head for a plugin the load order does not hold,
        // the opposite of ADR-0035's "hidden means absent".
        DeleteExistingForOrigin("records_committed", plugin, origin);
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        DeleteFormReferencesForPlugin(plugin, origin);
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);
        DeleteExistingForOrigin("container_child", plugin, origin);
    }

    // Blocking on the codec's async path is deliberate: serialization runs over a MemoryStream with
    // no IO, and making Index() async to match would push a false IO-bound shape up through
    // IRecordIndex for no benefit.
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

        // ADR-0041: a container's document carries its embedded children, as its source file does.
        // Do not add a reconciliation pass between inline copies and separate child files; that is
        // the shape the ADR's amendment exists to delete.
        var body = _codec.SerializeToBytesAsync(record, gameRelease).GetAwaiter().GetResult();
        // Hashed from the codec's own bytes rather than a string, so the hash is defined by what the
        // source file would contain.
        return new PreparedRecord(record, body, GitBlobHash.Of(body), refs, childRows, record.EditorID, ParseDiagnosis: null);
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
        if (prepared.EditorId is { } editorId)
            row.AppendValue(editorId);
        else
            row.AppendNullValue();
        row.AppendValue(SourceRef.Committed);
        row.AppendValue(Encoding.UTF8.GetString(prepared.Body));
        row.AppendValue(prepared.ContentHash);
        if (prepared.ParseDiagnosis is { } diagnosis)
            row.AppendValue(diagnosis);
        else
            row.AppendNullValue();
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

        // Per-record work is CPU-bound and independent, so it runs in parallel; only the appender
        // writes stay sequential. Bounded batches: preparing a whole type before appending any held
        // every body live, ~100 s of GC on Fallout4.esm.
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
                        tableName, record.FormKey, p.EditorId, plugin);
                    throw;
                }
                refs.AddRange(p.Refs);
                containerChildRows.AddRange(p.ChildRows);
                lookupRows.Add((record.FormKey.ToString(), tableName, p.EditorId));
                if (_logger.IsEnabled(LogLevel.Trace))
                {
                    _logger.LogTrace("Appended {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                        tableName, record.FormKey, p.EditorId, plugin);
                }
            }
            counters.AppendMs += batchTimer.ElapsedMilliseconds;
        }
    }

    // Large enough to keep eight cores busy on cheap records; small enough that a batch of the
    // largest cell documents stays inside a few hundred MB.
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
            var editorId = ReadEditorIdOrNull(record);
            _logger.LogWarning(ex,
                "Could not read {RecordType} record {FormKey} ({EditorID}) from {Plugin}; indexing it with its parse diagnosis",
                tableName, record.FormKey, editorId, plugin);
            return ParseFailed(record, editorId, PluginDiagnosis.FromParseException(ex).Describe());
        }
    }

    // No refs and no child rows: the walks that would produce them are the ones that just failed.
    private static PreparedRecord ParseFailed(IMajorRecordGetter record, string? editorId, string diagnosis)
    {
        var body = Encoding.UTF8.GetBytes(
            editorId == null ? "{}" : $"{{\"EditorID\":{JsonSerializer.Serialize(editorId)}}}");
        return new PreparedRecord(record, body, GitBlobHash.Of(body), [], [], editorId, diagnosis);
    }

    // The EditorID of an unreadable record is read through the same lazy Mutagen field access that
    // just threw, so it answers null rather than taking the plugin down with it.
    private static string? ReadEditorIdOrNull(IMajorRecordGetter record)
    {
        try { return record.EditorID; }
        catch (Exception) { return null; }
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

    // Shared by ingest and the per-record working-tree rederivation so the two paths cannot append
    // different column orders into the same table.
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
