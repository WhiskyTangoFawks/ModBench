using System.Text.Json.Nodes;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Edits;

/// <summary>What a copy reads of the record it is copying (ADR-0015). One per gesture,
/// not thread-safe.</summary>
internal sealed class CopySource(
    PluginAddress plugin, LoadOrderSnapshot loadOrder, IPluginAdapter adapter, RecordTextCodec codec, SchemaReflector schemaReflector)
    : IDisposable
{
    private readonly GameRelease _release = loadOrder.GameRelease;

    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas =
        schemaReflector.GetSchemas(loadOrder.GameRelease);

    // Tracked is the one condition under which a plugin has source text at all.
    private readonly SourceRepository? _tree = SourceRepository.TrackedModOf(loadOrder, plugin) is { } mod
        ? SourceRepository.Open(mod, loadOrder.GameRelease)
        : null;

    private IPluginRecordLookup? _loaded;
    private bool _opened;

    internal PluginAddress Plugin => plugin;

    /// <summary>The record type and EditorID this plugin's copy names <paramref name="formKey"/>, or
    /// null when it holds nothing under that key. A tracked plugin's document that is no record
    /// document refuses rather than reading as none.</summary>
    internal RecordIdentity? Identity(string formKey) =>
        _tree != null ? _tree.Get(plugin, formKey, _schemas)?.Identity : Loaded()?.IdentityOf(formKey);

    /// <summary>The record header's flags, read without the record's fields.</summary>
    internal long RecordFlags(RecordIdentity identity)
    {
        if (_tree == null) return Loaded()?.RecordFlagsOf(identity.FormKey) ?? throw NoLongerHeld(identity.FormKey);
        var body = _tree.Get(plugin, identity)?.Body ?? throw NoLongerHeld(identity.FormKey);
        return JsonNode.Parse(body) is JsonObject document ? RecordFlagsWrite.HeldBy(document) : 0;
    }

    /// <summary>The record's own text: the working tree's own bytes when tracked, otherwise the loaded
    /// plugin's record through the codec — byte for byte what Track would have written.</summary>
    internal string Body(RecordIdentity identity)
    {
        if (_tree == null) return Loaded()?.TextOf(identity.FormKey) ?? throw NoLongerHeld(identity.FormKey);

        var body = _tree.Get(plugin, identity)?.Body ?? throw NoLongerHeld(identity.FormKey);
        // Read through the codec even though the verbatim bytes are what lands: a copy of text no
        // reader can make a record of would leave the destination uncompilable.
        codec.RoundTrip(body, _release, identity.RecordType);
        return body;
    }

    /// <summary>The record's own text under the identity a copy files it by, which is what the
    /// destination writes and what the container rule appends.</summary>
    internal SourceDocument Document(RecordIdentity identity) =>
        new(identity.FormKey, identity.RecordType, identity.EditorId, Body(identity));

    /// <summary>The reader's own words for a record it cannot read: the codec's message for a working
    /// tree's document, the diagnosis Track uses for a plugin's own file.</summary>
    internal string Diagnose(Exception ex) =>
        _tree != null ? ex.Message : PluginDiagnosis.FromParseException(ex).Describe();

    /// <summary>The container carrying this record, or null when it has a document of its own. A cell
    /// always answers null: its place is <see cref="WorldspaceOf"/>'s, never a slot's.</summary>
    internal DocumentContainment? ContainerOf(RecordIdentity identity)
    {
        if (RecordTypeDispatch.For(_release).IsCell(identity.RecordType)) return null;
        return _tree != null ? _tree.ContainerOf(plugin, identity, _schemas) : Loaded()?.ContainmentOf(identity.FormKey);
    }

    /// <summary>The worldspace the cell <paramref name="identity"/> names sits in, or null for an interior
    /// cell or a cell this plugin does not hold.</summary>
    internal string? WorldspaceOf(RecordIdentity identity) =>
        _tree != null ? _tree.WorldspaceOf(plugin, identity) : Loaded()?.CellStructureOf(identity.FormKey)?.ParentWorldspace;

    /// <summary>Whether the cell's own document says which grid it sits at: a numbered exterior cell does,
    /// and a worldspace's own persistent cell does not.</summary>
    internal bool SitsAtAGrid(RecordIdentity identity) =>
        JsonNode.Parse(Body(identity)) is JsonObject cell && PlacedCell.Grid(cell) != null;

    /// <summary>The exterior cell this plugin holds at grid (<paramref name="x"/>, <paramref name="y"/>)
    /// of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    internal RecordIdentity? CellAt(string worldspace, int x, int y)
    {
        if (_tree != null) return _tree.GetCellAt(plugin, worldspace, x, y, _schemas)?.Identity;
        return Loaded()?.CellAt(worldspace, x, y) is { } formKey ? Loaded()?.IdentityOf(formKey) : null;
    }

    public void Dispose() => _loaded?.Dispose();

    // Null when the load order registers no such plugin: it holds nothing, which is an answer.
    private IPluginRecordLookup? Loaded()
    {
        if (_opened) return _loaded;
        _opened = true;
        if (loadOrder.Plugin(plugin) is { } registered)
            _loaded = adapter.OpenRecordLookup(registered, _release, _schemas);
        return _loaded;
    }

    private InvalidOperationException NoLongerHeld(string formKey) =>
        new($"{plugin.Name} stopped holding {formKey} mid-copy.");
}
