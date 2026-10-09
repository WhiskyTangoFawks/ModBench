using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.PluginAdapter;

/// <summary>A live mod answered one record at a time, as documents: the second half of
/// <see cref="MutagenModDocuments"/>'s job, for a caller asking about a handful of keys rather than the
/// whole plugin.</summary>
internal sealed class ModRecordLookup : IPluginRecords
{
    private readonly IModGetter _mod;
    private readonly PluginRecordBytes _file;
    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas;
    private readonly IDisposable? _open;
    private readonly RecordTypes _types;
    private readonly Lazy<ILinkCache> _cache;
    private readonly Lazy<Dictionary<string, DocumentContainment>> _containments;
    private readonly Lazy<Dictionary<string, HeldCell>> _cells;
    private readonly Lazy<Dictionary<(string Worldspace, int X, int Y), string>> _cellsByGrid;

    internal ModRecordLookup(
        IModGetter mod, PluginRecordBytes file, IReadOnlyDictionary<string, RecordTableSchema> schemas, IDisposable? open)
    {
        _mod = mod;
        _file = file;
        _schemas = schemas;
        _open = open;
        _types = RecordTypes.For(mod.GameRelease);
        _cache = new Lazy<ILinkCache>(() => mod.ToUntypedImmutableLinkCache());
        _containments = new Lazy<Dictionary<string, DocumentContainment>>(BuildContainments);
        _cells = new Lazy<Dictionary<string, HeldCell>>(() => MutagenModDocuments.CellsIn(mod));
        _cellsByGrid = new Lazy<Dictionary<(string Worldspace, int X, int Y), string>>(BuildCellsByGrid);
    }

    public PluginAnswer<RecordIdentity?> IdentityOf(string formKey) =>
        PluginFailure.Answer(() => Resolve(formKey) is { } record
            ? new RecordIdentity(record.FormKey.ToString(), _types.RecordTypeOf(record), record.EditorID)
            : (RecordIdentity?)null);

    public PluginAnswer<long?> RecordFlagsOf(string formKey) =>
        PluginFailure.Answer(() => (long?)Resolve(formKey)?.MajorRecordFlagsRaw);

    public PluginAnswer<string?> TextOf(string formKey) =>
        PluginFailure.Answer(() => Resolve(formKey) is { } record
            ? Encoding.UTF8.GetString(DeletedRecord.Serialize(
                record, _schemas[_types.RecordTypeOf(record)], _mod.GameRelease, () => _file.HoldsNoFields(record.FormKey)))
            : null);

    public PluginAnswer<DocumentContainment?> ContainmentOf(string formKey) =>
        PluginFailure.Answer(() => _containments.Value.TryGetValue(formKey, out var found) ? found : (DocumentContainment?)null);

    public PluginAnswer<CellStructure?> CellStructureOf(string formKey) =>
        PluginFailure.Answer(() => _cells.Value.TryGetValue(formKey, out var cell) ? cell.Structure : (CellStructure?)null);

    public PluginAnswer<string?> CellAt(string worldspace, int x, int y) =>
        PluginFailure.Answer(() => _cellsByGrid.Value.TryGetValue((worldspace, x, y), out var cell) ? cell : null);

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
            var parentType = _types.RecordTypeOf(record);
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
