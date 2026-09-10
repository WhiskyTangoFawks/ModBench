using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Serialization;

/// <summary>A live mod read as the documents its source tree would hold (ADR-0041). The one place a
/// getter becomes text, so every caller downstream of it holds documents.</summary>
internal static class ModDocuments
{
    /// <summary><paramref name="open"/> is disposed with the result, so a caller that opened the
    /// plugin hands ownership over rather than outliving the read.</summary>
    internal static IPluginDocuments Of(
        IModGetter mod, IReadOnlyDictionary<string, RecordTableSchema> schemas, IDisposable? open = null) =>
        new MutagenModDocuments(mod, schemas, open);

    /// <summary>Every cell in the mod and where the GRUP hierarchy puts it (ADR-0023), for a caller
    /// asking about placement without reading a document.</summary>
    internal static IReadOnlyDictionary<string, CellStructure> CellStructuresOf(IModGetter mod) =>
        MutagenModDocuments.CellsIn(mod).ToDictionary(c => c.Key, c => c.Value.Structure, StringComparer.Ordinal);
}

// Large enough to keep eight cores busy on cheap records; small enough that a batch of the largest
// cell documents stays inside a few hundred MB.
internal sealed class MutagenModDocuments(
    IModGetter mod, IReadOnlyDictionary<string, RecordTableSchema> schemas, IDisposable? open) : IPluginDocuments
{
    private const int SerializeBatchSize = 2048;

    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
    private readonly List<RecordTypeFailure> _failures = [];
    private readonly Lazy<Dictionary<string, CellRecord>> _cells = new(() => CellsIn(mod));

    // Where a cell sits and what its two placement groups hold, both read off the GRUP hierarchy so
    // neither depends on the codec having read the cell.
    internal readonly record struct CellRecord(CellStructure Structure, IReadOnlyList<PlacedInCell> Placed);

    public PluginDocument Header => new(
        PluginHeader.RecordType,
        PluginHeader.FormKeyFor(mod.ModKey),
        Encoding.UTF8.GetString(HeaderDocument.Write(mod)));

    public IReadOnlyList<RecordTypeFailure> Failures => _failures;

    /// <summary>The header is skipped: no ModHeader is a major record, so no enumeration reaches
    /// it.</summary>
    public IEnumerable<PluginDocument> Records
    {
        get
        {
            _failures.Clear();
            foreach (var (tableName, schema) in schemas)
            {
                if (tableName == PluginHeader.RecordType) continue;
                foreach (var document in DocumentsOf(tableName, schema)) yield return document;
            }
        }
    }

    public void Dispose() => open?.Dispose();

    // Enumerated one at a time rather than materialized in one shot: Mutagen's group enumerator
    // throws out of MoveNext and cannot be resumed, so everything it yielded first is kept and the
    // type carries the diagnosis for what never arrived.
    private IEnumerable<PluginDocument> DocumentsOf(string tableName, RecordTableSchema schema)
    {
        var records = new List<IMajorRecordGetter>();
        try
        {
            foreach (var record in mod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false))
                records.Add(record);
        }
        catch (Exception ex)
        {
            _failures.Add(new RecordTypeFailure(tableName, PluginDiagnosis.FromParseException(ex).Describe()));
        }

        // Serialization is CPU-bound and independent per record, so it runs in parallel; bounded
        // batches keep a whole type's bodies from being live at once.
        foreach (var batch in records.Chunk(SerializeBatchSize))
        {
            List<PluginDocument> documents;
            try
            {
                documents = [.. batch.AsParallel().AsOrdered().Select(record => Document(tableName, record))];
            }
            catch (AggregateException ex) when (ex.InnerExceptions.Count > 0)
            {
                ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
                throw;
            }

            foreach (var document in documents) yield return document;
        }
    }

    private PluginDocument Document(string tableName, IMajorRecordGetter record)
    {
        var formKey = record.FormKey.ToString();
        try
        {
            var text = Encoding.UTF8.GetString(
                _codec.SerializeToBytesAsync(record, mod.GameRelease).GetAwaiter().GetResult());
            return Placed(new PluginDocument(tableName, formKey, text), formKey);
        }
        catch (Exception ex)
        {
            var stub = ParseFailedDocument.For(record, EditorIdOrNull(record), mod.GameRelease);
            return Placed(
                new PluginDocument(
                    tableName, formKey, Encoding.UTF8.GetString(stub),
                    PluginDiagnosis.FromParseException(ex).Describe()),
                formKey);
        }
    }

    // The GRUP facts, attached whether or not the codec read the record: a cell the codec refuses
    // still belongs somewhere and still holds what it holds (ADR-0023).
    private PluginDocument Placed(PluginDocument document, string formKey) =>
        _cells.Value.TryGetValue(formKey, out var cell)
            ? document with { Cell = cell.Structure, Contents = cell.Placed }
            : document;

    // The EditorID of an unreadable record is read through the same lazy Mutagen field access that
    // just threw, so it answers null rather than taking the plugin down with it.
    private static string? EditorIdOrNull(IMajorRecordGetter record)
    {
        try { return record.EditorID; }
        catch (Exception) { return null; }
    }

    // ADR-0023: the worldspace/cell GRUP hierarchy, which EnumerateMajorRecords flattens away and no
    // document carries. Reflects on Mutagen's property names, the same across every game.
    internal static Dictionary<string, CellRecord> CellsIn(IModGetter mod)
    {
        var cells = new Dictionary<string, CellRecord>(StringComparer.Ordinal);

        foreach (var worldspace in Enumerate(Get(mod, "Worldspaces")))
        {
            var worldspaceFormKey = ((IMajorRecordGetter)worldspace).FormKey.ToString();
            if (Get(worldspace, "TopCell") is { } topCell)
                Record(cells, topCell, new CellStructure(worldspaceFormKey, null, null, null, null, false));

            foreach (var block in List(worldspace, "SubCells"))
            {
                int? blockX = Int(Get(block, RecordTypeDispatch.BlockNumberXMember));
                int? blockY = Int(Get(block, RecordTypeDispatch.BlockNumberYMember));
                foreach (var subBlock in List(block, "Items"))
                {
                    int? subX = Int(Get(subBlock, RecordTypeDispatch.BlockNumberXMember));
                    int? subY = Int(Get(subBlock, RecordTypeDispatch.BlockNumberYMember));
                    foreach (var cell in List(subBlock, "Items"))
                    {
                        Record(
                            cells, cell,
                            new CellStructure(worldspaceFormKey, blockX, blockY, subX, subY, false));
                    }
                }
            }
        }

        foreach (var cellBlock in Enumerate(Get(mod, "Cells")))
        {
            foreach (var subBlock in List(cellBlock, RecordTypeDispatch.BlockChildMember))
            {
                foreach (var cell in List(subBlock, RecordTypeDispatch.SubBlockChildMember))
                    Record(cells, cell, new CellStructure(null, null, null, null, null, true));
            }
        }

        return cells;
    }

    private static void Record(Dictionary<string, CellRecord> cells, object cell, CellStructure structure) =>
        cells[FormKeyOf(cell)] = new CellRecord(structure, [.. PlacedIn(cell)]);

    // Every placed record the cell's two groups hold, whatever its flavour: the placement table
    // covers a hazard or a projectile the same as a plain reference, and no schema is consulted.
    private static IEnumerable<PlacedInCell> PlacedIn(object cell)
    {
        foreach (var (slot, group) in new[] { ("Persistent", "persistent"), ("Temporary", "temporary") })
        {
            foreach (var placed in List(cell, slot))
            {
                if (placed is IMajorRecordGetter record)
                    yield return new PlacedInCell(record.FormKey.ToString(), group);
            }
        }
    }

    private static string FormKeyOf(object cell) => ((IMajorRecordGetter)cell).FormKey.ToString();

    private static readonly ConcurrentDictionary<(Type, string), MemberInfo?> Members = new();

    private static MemberInfo? Member(Type type, string name) =>
        Members.GetOrAdd((type, name), key =>
            (MemberInfo?)key.Item1.GetProperty(key.Item2, BindingFlags.Public | BindingFlags.Instance)
            ?? key.Item1.GetField(key.Item2, BindingFlags.Public | BindingFlags.Instance));

    private static object? Get(object? instance, string name) =>
        instance == null
            ? null
            : Member(instance.GetType(), name) switch
            {
                PropertyInfo property => property.GetValue(instance),
                FieldInfo field => field.GetValue(instance),
                _ => null,
            };

    private static IEnumerable<object> List(object? instance, string name) =>
        Get(instance, name) is IEnumerable items ? items.Cast<object>() : [];

    // Top-level groups differ by getter shape: the in-memory group has a "Records" member, the
    // binary-overlay wrapper is itself IEnumerable. Both are enumerable, so iterate the group itself.
    private static IEnumerable<object> Enumerate(object? group) =>
        group is IEnumerable items ? items.Cast<object>() : [];

    // Only called with block numbers, which are non-nullable on every level type.
    private static int Int(object? value) => Convert.ToInt32(value, CultureInfo.InvariantCulture);
}
