using System.Diagnostics;
using System.Runtime.ExceptionServices;
using System.Text;
using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Index;

/// <summary>The prepare/append/collectors collaborator of <see cref="DuckDbRecordIndex"/>, which
/// owns the transaction. <c>WorkingTreeOverlay</c> reuses the collectors so an edit's derived rows
/// come from the same code a fresh ingest uses.</summary>
internal sealed class PluginIngest
{
    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly ContainerDocuments _containers;

    public PluginIngest(DuckDBConnection connection, ILogger logger, ContainerDocuments containers)
    {
        _connection = connection;
        _logger = logger;
        _containers = containers;
    }

    internal readonly record struct IndexTiming(long DocumentsMs, long PrepareMs, long AppendMs, long ExtractedMs);

    // Everything the index derives from one document, computed off the appender thread; only writing
    // it is sequential. ParseDiagnosis is null for a record whose document was produced.
    private sealed record PreparedRecord(
        string RecordType, string FormKey, byte[] Body, string ContentHash, List<FormReferenceRow> Refs,
        List<ContainerChildRow> ChildRows, List<PlacementRow> Placements, CellLocationRow? CellLocation,
        string? EditorId, string? ParseDiagnosis);

    // ADR-0005, from the one stream that carries the documents. A DuckDB appender writes its rows
    // when disposed, so each is disposed here, inside the caller's transaction.
    public IndexTiming IndexPlugin(
        IPluginDocuments documents, string plugin, string origin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        using var documentAppender = _connection.CreateAppender("mirror", "records");

        var refs = new List<FormReferenceRow>();
        var lookupRows = new List<(string FormKey, string RecordType, string? EditorId)>();
        var containerChildRows = new List<ContainerChildRow>();
        var placementRows = new List<PlacementRow>();
        var cellLocationRows = new List<CellLocationRow>();

        var phaseTimer = Stopwatch.StartNew();
        var counters = new PhaseCounters();
        foreach (var batch in documents.Records.Chunk(PrepareBatchSize))
        {
            AppendBatch(
                batch, schemas, plugin, origin, documentAppender, counters,
                refs, lookupRows, containerChildRows, placementRows, cellLocationRows);
        }
        var documentsMs = phaseTimer.ElapsedMilliseconds;

        phaseTimer.Restart();
        WritePlacement(plugin, origin, placementRows, cellLocationRows);

        // Before the form_lookup flush, so the header's row and lookup row go through the same two
        // flushes as every record's: one lookup row per record row, by construction.
        if (schemas.ContainsKey(PluginHeader.RecordType))
            lookupRows.Add(HeaderIndexer.Index(documents.Header, plugin, origin, documentAppender));

        DeleteFormReferencesForPlugin(plugin, origin);
        if (refs.Count > 0)
        {
            using var refAppender = _connection.CreateAppender("mirror", "form_references");
            foreach (var r in refs)
                AppendFormReference(refAppender, r, plugin, origin);
        }

        // One form_lookup row per indexed record, with no second indexing pass over the
        // plugin.
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

        WriteTypeFailures(plugin, origin, documents.Failures);

        var extractedMs = phaseTimer.ElapsedMilliseconds;
        return new IndexTiming(documentsMs, counters.PrepareMs, counters.AppendMs, extractedMs);
    }

    // The inverse of IndexPlugin, table for table, built from the same per-plugin delete helper so a
    // new indexed table cannot be added to one side without the other noticing.
    public void DeleteAllRowsFor(string plugin, string origin)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        DeleteExistingForOrigin("form_lookup", plugin, origin);
        DeleteFormReferencesForPlugin(plugin, origin);
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);
        DeleteExistingForOrigin("container_child", plugin, origin);
        DeleteExistingForOrigin("record_type_failure", plugin, origin);
    }

    private sealed class PhaseCounters
    {
        public long PrepareMs;
        public long AppendMs;
    }

    // Large enough to keep eight cores busy on cheap records; small enough that a batch of the
    // largest cell documents stays inside a few hundred MB.
    private const int PrepareBatchSize = 2048;

    private void AppendBatch(
        PluginDocument[] batch, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string plugin, string origin, DuckDBAppender documentAppender, PhaseCounters counters,
        List<FormReferenceRow> refs,
        List<(string FormKey, string RecordType, string? EditorId)> lookupRows,
        List<ContainerChildRow> containerChildRows,
        List<PlacementRow> placementRows,
        List<CellLocationRow> cellLocationRows)
    {
        // Per-document work is CPU-bound and independent, so it runs in parallel; only the appender
        // writes stay sequential.
        List<PreparedRecord> prepared;
        var batchTimer = Stopwatch.StartNew();
        try
        {
            prepared = [.. batch
                .AsParallel().AsOrdered()
                .Select(document => PrepareRecord(document, schemas[document.RecordType]))];
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
            if (p.ParseDiagnosis is { } diagnosis && _logger.IsEnabled(LogLevel.Warning))
            {
                _logger.LogWarning(
                    "Could not read {RecordType} record {FormKey} ({EditorID}) from {Plugin}; indexing it with its parse diagnosis: {Diagnosis}",
                    p.RecordType, p.FormKey, p.EditorId, plugin, diagnosis);
            }

            try
            {
                AppendPrepared(documentAppender, p, plugin, origin);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Failed to append {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                    p.RecordType, p.FormKey, p.EditorId, plugin);
                throw;
            }
            refs.AddRange(p.Refs);
            containerChildRows.AddRange(p.ChildRows);
            placementRows.AddRange(p.Placements);
            if (p.CellLocation is { } cellLocation) cellLocationRows.Add(cellLocation);
            lookupRows.Add((p.FormKey, p.RecordType, p.EditorId));
            if (_logger.IsEnabled(LogLevel.Trace))
            {
                _logger.LogTrace("Appended {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                    p.RecordType, p.FormKey, p.EditorId, plugin);
            }
        }
        counters.AppendMs += batchTimer.ElapsedMilliseconds;
    }

    private PreparedRecord PrepareRecord(PluginDocument document, RecordTableSchema schema)
    {
        var body = Encoding.UTF8.GetBytes(document.Text);
        using var parsed = JsonDocument.Parse(body);
        var root = parsed.RootElement;
        var editorId = DocumentNodes.EditorIdOf(root);

        // ADR-0005: where a cell sits and what a container holds come from the GRUP
        // hierarchy, so a container whose document the codec refused still lists and still holds
        // its children. A refused cell loses only its grid.
        var refused = document.ParseDiagnosis is not null;
        JsonElement? carried = refused ? null : root;
        var containerType = _containers.ContainerTypeOf(document.RecordType);
        var placements = Placements(document, containerType, carried);
        CellLocationRow? cellLocation = document.Cell is { } structure
            ? PlacementWalker.CellLocation(document.FormKey, carried, structure)
            : null;

        // References are read off the document, never a live object: the document is the model, and
        // what Referenced-By answers is what the source file holds. A refused document holds none.
        List<FormReferenceRow> refs = refused
            ? []
            : Rows(_containers, root, schema, document.FormKey, editorId, document.RecordType);

        // A refused document holds no children either, so the GRUP answers for it.
        var children = refused
            ? (document.Contents ?? []).Select(c => (c.FormKey, c.SlotName, c.SlotIndex))
            : _containers.ChildrenOf(document.RecordType, root).Select(c => (c.FormKey, c.SlotName, c.SlotIndex));
        List<ContainerChildRow> childRows = [.. children
            .Where(c => PlacementWalker.TableFor(containerType, c.SlotName) == ParentageTable.ContainerChild)
            .Select(c => new ContainerChildRow(c.FormKey, document.FormKey, document.RecordType, c.SlotName, c.SlotIndex))];

        return new PreparedRecord(
            document.RecordType, document.FormKey, body, SourceRepository.ContentStamp(document.Text), refs, childRows,
            placements, cellLocation, editorId, document.ParseDiagnosis);
    }

    // One row per placed record the cell's groups hold, parentage from beside the document and
    // position from the child node the document carries — null where it carries none.
    private List<PlacementRow> Placements(PluginDocument document, string containerType, JsonElement? root)
    {
        var placed = (document.Contents ?? [])
            .Where(c => PlacementWalker.TableFor(containerType, c.SlotName) == ParentageTable.Placement)
            .ToList();
        if (placed.Count == 0) return [];

        var nodes = root is { } carried
            ? _containers.ChildrenOf(document.RecordType, carried)
                .GroupBy(c => c.FormKey, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.First().Node, StringComparer.Ordinal)
            : [];

        return [.. placed.Select(child => PlacementWalker.Placement(
            child.FormKey,
            nodes.TryGetValue(child.FormKey, out var node) ? node : null,
            document.FormKey,
            PlacementWalker.PlacementGroupOf(child.SlotName)))];
    }

    private static void AppendPrepared(
        DuckDBAppender documentAppender, PreparedRecord prepared, string plugin, string origin)
    {
        var row = documentAppender.CreateRow();
        row.AppendValue(prepared.FormKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(prepared.RecordType);
        if (prepared.EditorId is { } editorId)
            row.AppendValue(editorId);
        else
            row.AppendNullValue();
        row.AppendValue(WorkingTreeState.None.Stored());
        row.AppendValue(Encoding.UTF8.GetString(prepared.Body));
        row.AppendValue(prepared.ContentHash);
        if (prepared.ParseDiagnosis is { } diagnosis)
            row.AppendValue(diagnosis);
        else
            row.AppendNullValue();
        row.EndRow();
    }

    // The worldspace-tree side tables.
    private void WritePlacement(
        string plugin, string origin,
        List<PlacementRow> placementRows, List<CellLocationRow> cellLocationRows)
    {
        DeleteExistingForOrigin("placement", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);

        if (cellLocationRows.Count > 0)
        {
            using var cellAppender = _connection.CreateAppender("mirror", "cell_location");
            foreach (var row in cellLocationRows)
                AppendCellLocationRow(cellAppender, row, plugin, origin);
        }

        if (placementRows.Count == 0) return;
        using var placeAppender = _connection.CreateAppender("mirror", "placement");
        foreach (var row in placementRows)
            AppendPlacementRow(placeAppender, row, plugin, origin);
    }

    private void WriteTypeFailures(string plugin, string origin, IReadOnlyList<RecordTypeFailure> failures)
    {
        DeleteExistingForOrigin("record_type_failure", plugin, origin);
        if (failures.Count == 0) return;

        using var failureAppender = _connection.CreateAppender("mirror", "record_type_failure");
        foreach (var failure in failures)
        {
            _logger.LogWarning(
                "Could not finish enumerating {RecordType} records from {Plugin}: {Diagnosis}",
                failure.RecordType, plugin, failure.Diagnosis);

            var row = failureAppender.CreateRow();
            row.AppendValue(plugin);
            row.AppendValue(origin);
            row.AppendValue(failure.RecordType);
            row.AppendValue(failure.Diagnosis);
            row.EndRow();
        }
    }

    // The rows a record's own links become: a child it carries inline holds its own. Shared by
    // ingest and the per-record working-tree rederivation.
    internal static List<FormReferenceRow> Rows(
        ContainerDocuments containers, JsonElement root, RecordTableSchema schema,
        string sourceFormKey, string? sourceEditorId, string recordType) =>
        [.. containers.OwnReferences(recordType, FormReferences.Collect(root, schema))
            .Select(r => new FormReferenceRow(sourceFormKey, r.TargetFormKey, r.FieldPath, recordType, sourceEditorId))];

    // Shared by ingest and the per-record working-tree rederivation so the two paths cannot append
    // different column orders into the same table.
    internal static void AppendFormReference(DuckDBAppender appender, FormReferenceRow r, string plugin, string origin)
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

    // ADR-0012. Every reindexed table goes through this.
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
