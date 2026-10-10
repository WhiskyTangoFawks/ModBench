using System.Diagnostics;
using System.Runtime.ExceptionServices;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>The prepare/append/collectors collaborator of <see cref="Store"/>, which
/// owns the transaction. <c>WorkingTreeOverlay</c> reuses the collectors so an edit's derived rows
/// come from the same code a fresh ingest uses.</summary>
internal sealed class PluginIngest
{
    private readonly DuckDBConnection _connection;
    private readonly ILogger _logger;
    private readonly ContainerDocuments _containers;
    private readonly RecordTypes _types;

    public PluginIngest(DuckDBConnection connection, ILogger logger, GameRelease release)
    {
        _connection = connection;
        _logger = logger;
        _containers = new ContainerDocuments(release);
        _types = RecordTypes.For(release);
    }

    internal readonly record struct IndexTiming(long DocumentsMs, long PrepareMs, long AppendMs);

    // Everything the index derives from one document, computed off the appender thread; only writing
    // it is sequential. ParseDiagnosis is null for a record whose document was produced.
    internal sealed record PreparedRecord(
        string RecordType, string FormKey, string Body, string ContentHash, List<FormReferenceRow> Refs,
        List<HoldingRow> Holdings, List<CellLocationRow> CellLocations,
        string? EditorId, string? ParseDiagnosis);

    // ADR-0005, from the one stream that carries the documents. A DuckDB appender holds its rows
    // outside DuckDB's memory limit until it is disposed, so each batch disposes its own, inside the
    // caller's transaction.
    public IndexTiming IndexPlugin(
        IPluginDocuments documents, string plugin, string origin,
        IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        DeleteAllRowsFor(plugin, origin);
        var timer = Stopwatch.StartNew();
        var counters = new PhaseCounters();
        foreach (var batch in Batches(documents.Records))
            AppendBatch(batch, schemas, plugin, origin, counters);

        if (schemas.ContainsKey(PluginHeader.RecordType))
        {
            using var headerAppender = _connection.CreateAppender(TableDdlBuilder.MirrorSchema, "records");
            HeaderIndexer.Index(documents.Header, plugin, origin, headerAppender);
        }
        WriteTypeFailures(plugin, origin, documents.Failures);
        return new IndexTiming(timer.ElapsedMilliseconds, counters.PrepareMs, counters.AppendMs);
    }

    // The inverse of IndexPlugin, table for table, built from the same per-plugin delete helper so a
    // new indexed table cannot be added to one side without the other noticing.
    public void DeleteAllRowsFor(string plugin, string origin)
    {
        DeleteExistingForOrigin("records", plugin, origin);
        DeleteFormReferencesForPlugin(plugin, origin);
        DeleteExistingForOrigin("holdings", plugin, origin);
        DeleteExistingForOrigin("cell_location", plugin, origin);
        DeleteExistingForOrigin("record_type_failure", plugin, origin);
    }

    private sealed class PhaseCounters
    {
        public long PrepareMs;
        public long AppendMs;
    }

    private sealed class Appenders(DuckDBConnection connection) : IDisposable
    {
        public DuckDBAppender Records { get; } = connection.CreateAppender(TableDdlBuilder.MirrorSchema, "records");
        public DuckDBAppender FormReferences { get; } = connection.CreateAppender(TableDdlBuilder.MirrorSchema, "form_references");
        public DuckDBAppender Holdings { get; } = connection.CreateAppender(TableDdlBuilder.MirrorSchema, "holdings");
        public DuckDBAppender CellLocations { get; } = connection.CreateAppender(TableDdlBuilder.MirrorSchema, "cell_location");

        public void Dispose()
        {
            Records.Dispose();
            FormReferences.Dispose();
            Holdings.Dispose();
            CellLocations.Dispose();
        }
    }

    // Large enough to keep eight cores busy on cheap records. A master's cell documents run to a
    // megabyte apiece, so a batch also closes at a size.
    private const int PrepareBatchSize = 2048;
    private const long PrepareBatchChars = 16 * 1024 * 1024;

    private static IEnumerable<List<PluginDocument>> Batches(IEnumerable<PluginDocument> documents)
    {
        List<PluginDocument> batch = [];
        long chars = 0;
        foreach (var document in documents)
        {
            batch.Add(document);
            chars += document.Text.Length;
            if (batch.Count < PrepareBatchSize && chars < PrepareBatchChars) continue;
            yield return batch;
            batch = [];
            chars = 0;
        }
        if (batch.Count > 0) yield return batch;
    }

    private void AppendBatch(
        List<PluginDocument> batch, IReadOnlyDictionary<string, RecordTableSchema> schemas,
        string plugin, string origin, PhaseCounters counters)
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
        Append(prepared, plugin, origin);
        counters.AppendMs += batchTimer.ElapsedMilliseconds;
    }

    private void Append(List<PreparedRecord> prepared, string plugin, string origin)
    {
        using var appenders = new Appenders(_connection);
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
                AppendPrepared(appenders.Records, p, plugin, origin);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex,
                    "Failed to append {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                    p.RecordType, p.FormKey, p.EditorId, plugin);
                throw;
            }
            foreach (var r in p.Refs)
                AppendFormReference(appenders.FormReferences, r, plugin, origin);
            foreach (var row in p.Holdings)
                AppendHoldingRow(appenders.Holdings, row, plugin, origin);
            foreach (var row in p.CellLocations)
                AppendCellLocationRow(appenders.CellLocations, row, plugin, origin);
            if (_logger.IsEnabled(LogLevel.Trace))
            {
                _logger.LogTrace("Appended {RecordType} record {FormKey} ({EditorID}) from {Plugin}",
                    p.RecordType, p.FormKey, p.EditorId, plugin);
            }
        }
    }

    internal PreparedRecord PrepareRecord(
        PluginDocument document, RecordTableSchema schema, List<ContainerDocuments.ChildDocument>? childDocuments = null)
    {
        var root = Document.Parse(document.Text);
        var editorId = root.EditorId.EditorId;

        // ADR-0005: where a cell sits and what a container holds come from the GRUP
        // hierarchy, so a container whose document the codec refused still lists and still holds
        // its children. A refused cell loses only its grid.
        var refused = document.ParseDiagnosis is not null;

        // References are read off the document, never a live object: the document is the model, and
        // what Referenced-By answers is what the source file holds. A refused document holds none.
        List<FormReferenceRow> refs = refused
            ? []
            : Rows(_containers, root, schema, document.FormKey, editorId, document.RecordType);

        if (!refused) childDocuments?.AddRange(_containers.ChildrenOf(document.RecordType, root));
        var children = refused
            ? (document.Contents ?? []).Select(c => (c.FormKey, c.SlotName, c.SlotIndex, Child: (Document?)null))
            : (childDocuments ?? [.. _containers.ChildrenOf(document.RecordType, root)])
                .Select(c => (c.FormKey, c.SlotName, c.SlotIndex, Child: (Document?)c.Document));
        var holdings = new List<HoldingRow>();
        var cellLocations = new List<CellLocationRow>();
        foreach (var (formKey, slot, index, childDocument) in children)
        {
            holdings.Add(new HoldingRow(document.FormKey, formKey, slot, index));
            if (slot == PlacedCell.WorldspacePersistentCellMember && _types.IsWorldspace(document.RecordType))
            {
                cellLocations.Add(CellLocations.Of(formKey, childDocument, structure: null));
            }
        }

        if (document.Cell is { Place: not CellPlace.PersistentWorldspaceCell } structure)
        {
            cellLocations.Add(CellLocations.Of(document.FormKey, refused ? null : root, structure));
            if (structure.ParentWorldspace is { } worldspace)
                holdings.Add(new HoldingRow(worldspace, document.FormKey, HoldingSlots.ExteriorCell, 0));
        }

        return new PreparedRecord(
            document.RecordType, document.FormKey, document.Text, SourceRepository.ContentStamp(document.Text), refs,
            holdings, cellLocations, editorId, document.ParseDiagnosis);
    }

    private static void AppendPrepared(
        DuckDBAppender documentAppender, PreparedRecord prepared, string plugin, string origin)
    {
        var row = documentAppender.CreateRow();
        row.AppendValue(prepared.FormKey);
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendValue(prepared.RecordType);
        row.AppendValue(prepared.EditorId);
        row.AppendValue(WorkingTreeState.None.Stored());
        row.AppendValue(prepared.Body);
        row.AppendValue(prepared.ContentHash);
        row.AppendValue(prepared.ParseDiagnosis);
        row.EndRow();
    }

    private void WriteTypeFailures(string plugin, string origin, IReadOnlyList<RecordTypeFailure> failures)
    {
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
        ContainerDocuments containers, Document root, RecordTableSchema schema,
        string sourceFormKey, string? sourceEditorId, string recordType) =>
        [.. containers.OwnReferences(recordType, FormReferences.Collect(root, schema.RecordColumns))
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
        row.AppendValue(r.EditorId);
        row.EndRow();
    }

    private void DeleteFormReferencesForPlugin(string plugin, string origin) =>
        DuckDbSql.Execute(_connection,
            "DELETE FROM mirror.form_references WHERE source_plugin = $1 AND source_origin = $2", plugin, origin);

    // ADR-0012. Every reindexed table goes through this.
    private void DeleteExistingForOrigin(string tableName, string plugin, string origin) =>
        DuckDbSql.Execute(_connection, $"DELETE FROM mirror.\"{tableName}\" WHERE plugin = $1 AND origin = $2", plugin, origin);

    internal static void AppendHoldingRow(DuckDBAppender appender, HoldingRow row, string plugin, string origin)
    {
        var r = appender.CreateRow();
        r.AppendValue(plugin);
        r.AppendValue(origin);
        r.AppendValue(row.Parent);
        r.AppendValue(row.Child);
        r.AppendValue(row.Slot);
        r.AppendValue(row.SlotIndex);
        r.EndRow();
    }

    internal static void AppendCellLocationRow(DuckDBAppender appender, CellLocationRow row, string plugin, string origin)
    {
        var r = appender.CreateRow();
        r.AppendValue(row.CellFormKey);
        r.AppendValue(plugin);
        r.AppendValue(origin);
        r.AppendValue(row.BlockX);
        r.AppendValue(row.BlockY);
        r.AppendValue(row.SubX);
        r.AppendValue(row.SubY);
        r.AppendValue(row.GridX);
        r.AppendValue(row.GridY);
        r.EndRow();
    }
}
