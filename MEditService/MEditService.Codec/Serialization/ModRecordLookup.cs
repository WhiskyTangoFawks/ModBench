using System.Text;
using MEditService.Codec.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A live mod answered one record at a time, as documents: the second half of
/// <see cref="ModDocuments"/>'s job, for a caller asking about a handful of keys rather than the
/// whole plugin.</summary>
internal sealed class ModRecordLookup : IPluginRecordLookup
{
    private readonly IModGetter _mod;
    private readonly IRecordFieldProbe _file;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;
    private readonly IDisposable? _open;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);
    private readonly Lazy<ILinkCache> _cache;
    private readonly Lazy<Dictionary<string, DocumentContainment>> _containments;
    private readonly Lazy<Dictionary<string, HeldCell>> _cells;
    private readonly Lazy<Dictionary<(string Worldspace, int X, int Y), string>> _cellsByGrid;

    internal ModRecordLookup(
        IModGetter mod, IRecordFieldProbe file, IReadOnlyDictionary<string, RecordTableSchema> schemas, IDisposable? open)
    {
        _mod = mod;
        _file = file;
        _schemas = schemas;
        _open = open;
        _cache = new Lazy<ILinkCache>(() => mod.ToUntypedImmutableLinkCache());
        _containments = new Lazy<Dictionary<string, DocumentContainment>>(BuildContainments);
        _cells = new Lazy<Dictionary<string, HeldCell>>(() => MutagenModDocuments.CellsIn(mod));
        _cellsByGrid = new Lazy<Dictionary<(string Worldspace, int X, int Y), string>>(BuildCellsByGrid);
    }

    public RecordIdentity? IdentityOf(string formKey) =>
        Resolve(formKey) is { } record
            ? new RecordIdentity(record.FormKey.ToString(), RecordTableName.Of(record.GetType(), _schemas), record.EditorID)
            : null;

    public long? RecordFlagsOf(string formKey) => Resolve(formKey)?.MajorRecordFlagsRaw;

    public string? TextOf(string formKey) =>
        Resolve(formKey) is { } record
            ? Encoding.UTF8.GetString(DeletedRecord.Serialize(_codec, record, _schemas[RecordTableName.Of(record.GetType(), _schemas)], _mod.GameRelease, _file))
            : null;

    public DocumentContainment? ContainmentOf(string formKey) =>
        _containments.Value.TryGetValue(formKey, out var found) ? found : null;

    public CellStructure? CellStructureOf(string formKey) =>
        _cells.Value.TryGetValue(formKey, out var cell) ? cell.Structure : null;

    public string? CellAt(string worldspace, int x, int y) =>
        _cellsByGrid.Value.TryGetValue((worldspace, x, y), out var cell) ? cell : null;

    public void Dispose()
    {
        if (_cache.IsValueCreated) _cache.Value.Dispose();
        _open?.Dispose();
    }

    private IMajorRecordGetter? Resolve(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed)
        && _cache.Value.TryResolve<IMajorRecordGetter>(parsed, out var record)
            ? record
            : null;

    // A worldspace's cells under its blocks, by the grid each names.
    private Dictionary<(string Worldspace, int X, int Y), string> BuildCellsByGrid()
    {
        var cells = new Dictionary<(string Worldspace, int X, int Y), string>();
        foreach (var (formKey, (structure, cell)) in _cells.Value)
        {
            if (structure is not { ParentWorldspace: { } worldspace, BlockX: not null }) continue;
            if (MutagenModDocuments.GridOf(cell) is { } grid) cells.TryAdd((worldspace, grid.X, grid.Y), formKey);
        }
        return cells;
    }

    // Every child slot names its parent, which is what a tracked plugin reads out of the owner
    // document instead. A block is not a record, so a worldspace's cells are not here.
    private Dictionary<string, DocumentContainment> BuildContainments()
    {
        var containments = new Dictionary<string, DocumentContainment>(StringComparer.Ordinal);
        foreach (var record in _mod.EnumerateMajorRecords())
        {
            var parentType = RecordTableName.Of(record.GetType(), _schemas);
            foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(record))
            {
                containments.TryAdd(
                    child.FormKey.ToString(),
                    new DocumentContainment(record.FormKey.ToString(), parentType, slotName));
            }
        }
        return containments;
    }
}
