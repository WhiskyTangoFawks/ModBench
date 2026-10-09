using System.Collections;
using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using System.Runtime.ExceptionServices;
using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.PluginAdapter;

/// <summary>A cell the mod holds, where its GRUP hierarchy puts it.</summary>
internal readonly record struct HeldCell(CellStructure Structure, object Cell);

/// <summary>A live mod read as the documents its source tree would hold (ADR-0007). The open is
/// disposed with the result, so a caller that opened the plugin hands ownership over.</summary>
internal sealed class MutagenModDocuments(
    IModGetter mod, PluginRecordBytes file, IReadOnlyDictionary<string, RecordTableSchema> schemas, IDisposable? open) : IPluginDocuments
{
    // Large enough to keep eight cores busy on cheap records; small enough that a batch of the largest
    // cell documents stays inside a few hundred MB.
    private const int SerializeBatchSize = 2048;

    private readonly List<RecordTypeFailure> _failures = [];
    private readonly Lazy<Dictionary<string, HeldCell>> _cells = new(() => CellsIn(mod));

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
            foreach (var record in schema.RecordsIn(mod))
                records.Add(record);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
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
                documents = [.. batch.AsParallel().AsOrdered().Select(record => Document(tableName, schema, record))];
            }
            catch (AggregateException ex) when (ex.InnerExceptions.Count > 0)
            {
                ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
                throw;
            }

            foreach (var document in documents) yield return document;
        }
    }

    private PluginDocument Document(string tableName, RecordTableSchema schema, IMajorRecordGetter record)
    {
        var formKey = record.FormKey.ToString();
        try
        {
            var text = Encoding.UTF8.GetString(DeletedRecord.Serialize(record, schema, mod.GameRelease, () => file.HoldsNoFields(record.FormKey)));
            return WithGrupFacts(new PluginDocument(tableName, formKey, text), record);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            var stub = ParseFailedDocument.For(record, EditorIdOrNull(record), mod.GameRelease);
            return WithGrupFacts(
                new PluginDocument(
                    tableName, formKey, Encoding.UTF8.GetString(stub),
                    PluginDiagnosis.FromParseException(ex).Describe()),
                record);
        }
    }

    // Attached whether or not the codec read the record (ADR-0005).
    private PluginDocument WithGrupFacts(PluginDocument document, IMajorRecordGetter record) =>
        document with
        {
            Cell = _cells.Value.TryGetValue(document.FormKey, out var cell) ? cell.Structure : null,
            Contents = [.. ContainerChildFields.EnumerateChildren(record)
                .Select(c => new ChildRecord(c.Child.FormKey.ToString(), c.SlotName, c.SlotIndex))],
        };

    // The EditorID of an unreadable record is read through the same lazy Mutagen field access that
    // just threw, so it answers null rather than taking the plugin down with it.
    private static string? EditorIdOrNull(IMajorRecordGetter record)
    {
        try { return record.EditorID; }
        catch (Exception ex) when (ex is not OutOfMemoryException) { return null; }
    }

    // plugins.md, The tree, story 6: the worldspace/cell GRUP hierarchy, which EnumerateMajorRecords
    // flattens away and no document carries. Reflects on Mutagen's property names, the same across every game.
    internal static Dictionary<string, HeldCell> CellsIn(IModGetter mod)
    {
        var cells = new Dictionary<string, HeldCell>(StringComparer.Ordinal);

        foreach (var worldspace in Enumerate(Get(mod, "Worldspaces")))
        {
            var worldspaceFormKey = ((IMajorRecordGetter)worldspace).FormKey.ToString();
            if (Get(worldspace, "TopCell") is { } topCell)
                Record(cells, topCell, new CellStructure(worldspaceFormKey, null, null, null, null, false));

            foreach (var block in List(worldspace, "SubCells"))
            {
                int? blockX = Int(Get(block, RecordTypes.BlockNumberXMember));
                int? blockY = Int(Get(block, RecordTypes.BlockNumberYMember));
                foreach (var subBlock in List(block, "Items"))
                {
                    int? subX = Int(Get(subBlock, RecordTypes.BlockNumberXMember));
                    int? subY = Int(Get(subBlock, RecordTypes.BlockNumberYMember));
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
            int? block = Int(Get(cellBlock, RecordTypes.BlockNumberMember));
            foreach (var subBlock in List(cellBlock, RecordTypes.BlockChildMember))
            {
                int? sub = Int(Get(subBlock, RecordTypes.BlockNumberMember));
                foreach (var cell in List(subBlock, RecordTypes.SubBlockChildMember))
                    Record(cells, cell, CellStructure.Interior(block, sub));
            }
        }

        return cells;
    }

    private static void Record(Dictionary<string, HeldCell> cells, object cell, CellStructure structure) =>
        cells[FormKeyOf(cell)] = new HeldCell(structure, cell);

    /// <summary>The grid the cell names, or null when it names none.</summary>
    internal static (int X, int Y)? GridOf(object cell) =>
        Get(Get(cell, RecordTypes.CellGridMember), PlacedCell.GridPointMember) is P2Int point ? (point.X, point.Y) : null;

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
