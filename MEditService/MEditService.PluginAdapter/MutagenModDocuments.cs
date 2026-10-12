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
    // Large enough to keep eight cores busy on cheap records. A master's cell documents run to a
    // megabyte apiece, so a batch also closes at a size.
    private const int SerializeBatchSize = 2048;
    private const long SerializeBatchChars = 16 * 1024 * 1024;

    private readonly List<RecordTypeFailure> _failures = [];
    private readonly Lazy<Dictionary<string, CellStructure>> _cells = new(() =>
        CellsIn(mod).ToDictionary(cell => cell.Key, cell => cell.Value.Structure, StringComparer.Ordinal));

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
            using var records = Spread().GetEnumerator();
            var pending = new List<HeldRecord>(SerializeBatchSize);
            var recordsRemain = RecordsRemainAfterTopUp(records, pending);
            while (pending.Count > 0)
            {
                var documents = SerializedPrefix(pending);
                pending.RemoveRange(0, documents.Count);
                foreach (var document in documents) yield return document;
                recordsRemain = recordsRemain && RecordsRemainAfterTopUp(records, pending);
            }
        }
    }

    public void Dispose() => open?.Dispose();

    private readonly record struct HeldRecord(string TableName, RecordTableSchema Schema, IMajorRecordGetter Getter);

    // DuckDB reads 2048 consecutive rows at once, so a group of multi-megabyte documents in one run
    // holds gigabytes. Each table with a group of its own is spread over the plugin by its share of
    // the records. The tables that share a walk follow one another in one stream, so no walk is held twice.
    private IEnumerable<HeldRecord> Spread()
    {
        var tables = schemas.Where(table => table.Key != PluginHeader.RecordType).ToList();
        var separate = tables
            .Select(table => (Count: SeparateGroupCount(table.Value), Table: table))
            .ToList();
        var shared = SharedRecords([.. separate.Where(s => s.Count is null).Select(s => s.Table)]);
        var streams = separate
            .Where(s => s.Count > 0)
            .Select(s => (Count: s.Count ?? 0, Records: RecordsOf(s.Table.Key, s.Table.Value).GetEnumerator()))
            .ToList();
        streams.Add((Math.Max(1, RecordCountInHeader() - streams.Sum(s => s.Count)), shared.GetEnumerator()));

        var queue = new PriorityQueue<int, (double Share, int Stream)>();
        var taken = new int[streams.Count];
        try
        {
            for (var stream = 0; stream < streams.Count; stream++) queue.Enqueue(stream, (0.5 / streams[stream].Count, stream));
            while (queue.TryDequeue(out var stream, out _))
            {
                if (!streams[stream].Records.MoveNext()) continue;
                yield return streams[stream].Records.Current;
                taken[stream]++;
                queue.Enqueue(stream, ((taken[stream] + 0.5) / streams[stream].Count, stream));
            }
        }
        finally
        {
            foreach (var (_, records) in streams) records.Dispose();
        }
    }

    // One walk of the plugin reads each group once, where a walk per table reads its container's whole
    // group again for each table nested in it. A walk Mutagen stops partway leaves each table to its
    // own walk, past the records it already gave, so each table Mutagen cannot read reports itself.
    private IEnumerable<HeldRecord> SharedRecords(IReadOnlyList<KeyValuePair<string, RecordTableSchema>> tables)
    {
        var schemaOf = tables.ToDictionary(table => table.Key, table => table.Value, StringComparer.Ordinal);
        var given = new Dictionary<string, int>(StringComparer.Ordinal);
        var types = RecordTypes.For(mod.GameRelease);
        var stoppedPartway = false;
        bool Continues(IEnumerator<IMajorRecordGetter> walk)
        {
            try
            {
                return walk.MoveNext();
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                PluginFailure.ThrowIfNotTheFilesAnswer(ex, file);
                stoppedPartway = true;
                return false;
            }
        }
        using (var walk = mod.EnumerateMajorRecords().GetEnumerator())
        {
            while (Continues(walk))
            {
                var tableName = types.RecordTypeOf(walk.Current);
                if (!schemaOf.TryGetValue(tableName, out var schema)) continue;
                given[tableName] = given.GetValueOrDefault(tableName) + 1;
                yield return new HeldRecord(tableName, schema, walk.Current);
            }
            if (!stoppedPartway) yield break;
        }
        foreach (var (tableName, schema) in tables)
        {
            foreach (var record in RecordsOf(tableName, schema).Skip(given.GetValueOrDefault(tableName))) yield return record;
        }
    }

    // A group whose location scan Mutagen refuses throws on its count as on its walk, so the walk
    // takes it and reports it.
    private int? SeparateGroupCount(RecordTableSchema schema)
    {
        try
        {
            return schema.SeparateGroupCountIn(mod);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            PluginFailure.ThrowIfNotTheFilesAnswer(ex, file);
            return null;
        }
    }

    // Mutagen's group enumerator throws out of MoveNext and cannot be resumed, so everything it yielded
    // first is kept and the type carries the diagnosis for what never arrived.
    private IEnumerable<HeldRecord> RecordsOf(string tableName, RecordTableSchema schema)
    {
        using var records = schema.RecordsIn(mod).GetEnumerator();
        while (true)
        {
            try
            {
                if (!records.MoveNext()) yield break;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                PluginFailure.ThrowIfNotTheFilesAnswer(ex, file);
                _failures.Add(new RecordTypeFailure(tableName, PluginDiagnosis.FromParseException(ex).Describe()));
                yield break;
            }
            yield return new HeldRecord(tableName, schema, records.Current);
        }
    }

    // The header's count of what the plugin holds, groups included: a share of the records needs no
    // more than an estimate, and walking the plugin to count it costs a read of every group.
    private int RecordCountInHeader() =>
        Get(Get(Get(mod, "ModHeader"), "Stats"), "NumRecords") is uint count ? (int)Math.Min(count, int.MaxValue) : 0;

    private static bool RecordsRemainAfterTopUp(IEnumerator<HeldRecord> records, List<HeldRecord> pending)
    {
        while (pending.Count < SerializeBatchSize)
        {
            if (!records.MoveNext()) return false;
            pending.Add(records.Current);
        }
        return true;
    }

    // Serialization is CPU-bound and independent per record, so it runs in parallel.
    private List<PluginDocument> SerializedPrefix(List<HeldRecord> records)
    {
        var documents = new PluginDocument[records.Count];
        var taken = -1;
        long chars = 0;
        try
        {
            Parallel.For(0, Environment.ProcessorCount, (_, loop) =>
            {
                int next;
                while (!loop.ShouldExitCurrentIteration && Interlocked.Read(ref chars) < SerializeBatchChars
                    && (next = Interlocked.Increment(ref taken)) < records.Count)
                {
                    var (tableName, schema, record) = records[next];
                    documents[next] = Document(tableName, schema, record);
                    Interlocked.Add(ref chars, documents[next].Text.Length);
                }
            });
        }
        catch (AggregateException ex) when (ex.InnerExceptions.Count > 0)
        {
            ExceptionDispatchInfo.Capture(ex.InnerExceptions[0]).Throw();
            throw;
        }
        return [.. documents.Take(Math.Min(taken + 1, records.Count))];
    }

    private PluginDocument Document(string tableName, RecordTableSchema schema, IMajorRecordGetter record)
    {
        var formKey = record.FormKey.ToString();
        try
        {
            var text = Encoding.UTF8.GetString(DeletedRecord.Serialize(record, schema, mod.GameRelease, () => file.HoldsNoFields(record.FormKey)));
            return WithGrupFacts(new PluginDocument(tableName, formKey, text), record);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            PluginFailure.ThrowIfNotTheFilesAnswer(ex, file);
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
            Cell = _cells.Value.TryGetValue(document.FormKey, out var cell) ? cell : null,
            Contents = [.. ContainerChildFields.EnumerateChildren(record)
                .Select(c => new ChildRecord(c.Child.FormKey.ToString(), c.SlotName, c.SlotIndex))],
        };

    // The EditorID of an unreadable record is read through the same lazy Mutagen field access that
    // just threw, so it answers null rather than taking the plugin down with it.
    private string? EditorIdOrNull(IMajorRecordGetter record)
    {
        try { return record.EditorID; }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            PluginFailure.ThrowIfNotTheFilesAnswer(ex, file);
            return null;
        }
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
