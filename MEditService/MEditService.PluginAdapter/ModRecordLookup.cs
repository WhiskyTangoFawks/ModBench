using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.RepositoriesLib;
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
    private readonly Lazy<PluginRecordFacts> _facts;
    private readonly Lazy<ILinkCache> _cache;
    private readonly Lazy<Dictionary<string, HeldCell>> _cells;
    private readonly Lazy<Dictionary<(string Worldspace, int X, int Y), string>> _cellsByGrid;

    internal ModRecordLookup(
        IModGetter mod, PluginRecordBytes file, IReadOnlyDictionary<string, RecordTableSchema> schemas, Func<PluginRecordFacts> facts,
        IDisposable? open)
    {
        _mod = mod;
        _file = file;
        _schemas = schemas;
        _facts = new Lazy<PluginRecordFacts>(facts);
        _open = open;
        _cache = new Lazy<ILinkCache>(() => mod.ToUntypedImmutableLinkCache());
        _cells = new Lazy<Dictionary<string, HeldCell>>(() => MutagenModDocuments.CellsIn(mod));
        _cellsByGrid = new Lazy<Dictionary<(string Worldspace, int X, int Y), string>>(BuildCellsByGrid);
    }

    public Answer<RecordIdentity?, PluginFailure> IdentityOf(string formKey) =>
        PluginFailure.Answer(() => FactOf(formKey) is var (parsed, fact)
            ? new RecordIdentity(parsed.ToString(), fact.RecordType, fact.EditorId)
            : (RecordIdentity?)null, _file);

    public Answer<long?, PluginFailure> RecordFlagsOf(string formKey) =>
        PluginFailure.Answer(() => FactOf(formKey) is var (_, fact) ? fact.Flags : (long?)null, _file);

    // Asked by its type: the link cache walks the whole mod to find a record of a type it is not told.
    public Answer<string?, PluginFailure> TextOf(string formKey) =>
        PluginFailure.Answer(() => FactOf(formKey) is var (parsed, fact) && _cache.Value.TryResolve(parsed, fact.GetterType, out var record)
            ? Encoding.UTF8.GetString(DeletedRecord.Serialize(
                record, _schemas[fact.RecordType], _mod.GameRelease, () => _file.HoldsNoFields(parsed)))
            : null, _file);

    public Answer<DocumentContainment?, PluginFailure> ContainmentOf(string formKey) =>
        PluginFailure.Answer(() => FormKey.TryFactory(formKey, out var parsed) && _facts.Value.Containments.TryGetValue(parsed, out var found)
            ? found
            : (DocumentContainment?)null, _file);

    public Answer<CellStructure?, PluginFailure> CellStructureOf(string formKey) =>
        PluginFailure.Answer(() => _cells.Value.TryGetValue(formKey, out var cell) ? cell.Structure : (CellStructure?)null, _file);

    public Answer<string?, PluginFailure> CellAt(string worldspace, int x, int y) =>
        PluginFailure.Answer(() => _cellsByGrid.Value.TryGetValue((worldspace, x, y), out var cell) ? cell : null, _file);

    public void Dispose()
    {
        if (_cache.IsValueCreated) _cache.Value.Dispose();
        _open?.Dispose();
    }

    private (FormKey Key, PluginRecordFacts.Fact Fact)? FactOf(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) && _facts.Value.Records.TryGetValue(parsed, out var fact) ? (parsed, fact) : null;

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
}
