using System.Text.Json;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Core.Edits;

/// <summary>What a copy reads of the record it is copying (ADR-0015 invariant 5): a tracked source
/// answers from its working tree, an untracked one from the loaded copy through the codec. One per
/// gesture, not thread-safe.</summary>
internal sealed class CopySource(
    PluginKey plugin, LoadOrder loadOrder, IPluginAdapter adapter, RecordTextCodec codec, SchemaReflector schemaReflector)
    : IDisposable
{
    private readonly GameRelease _release = loadOrder.GameRelease;

    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas =
        schemaReflector.GetSchemas(loadOrder.GameRelease);

    // Tracked is the one condition under which a plugin has source text at all.
    private readonly SourceRepository? _tree = ModFolders.TrackedOf(loadOrder, plugin) is { } modFolder
        ? SourceRepository.Open(modFolder, loadOrder.GameRelease)
        : null;

    private readonly Lazy<ContainerDocuments> _containers = new(
        () => new ContainerDocuments(loadOrder.GameRelease, schemaReflector.GetSchemas(loadOrder.GameRelease)));

    private IPluginRecordLookup? _loaded;
    private bool _opened;

    internal PluginKey Plugin => plugin;

    /// <summary>The record type and EditorID this plugin's copy names <paramref name="formKey"/>, or
    /// null when it holds nothing under that key.</summary>
    internal RecordIdentity? Identity(string formKey) =>
        _tree != null ? _tree.IdentityOf(plugin, formKey, _schemas) : Loaded()?.IdentityOf(formKey);

    /// <summary>The record's own text: the working tree's own bytes when tracked, otherwise the loaded
    /// copy's record through the codec — byte for byte what Track would have written.</summary>
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
    /// always answers null: its place is <see cref="CellPlacementOf"/>'s, never a slot's.</summary>
    internal DocumentContainment? ContainerOf(RecordIdentity identity)
    {
        if (RecordTypeDispatch.For(_release).IsCell(identity.RecordType)) return null;
        if (_tree == null) return Loaded()?.ContainmentOf(identity.FormKey);
        if (_tree.Locate(plugin, identity) is not { IsEmbedded: true }) return null;

        var carrier = _tree.Carrier(plugin, identity, _schemas)
            ?? throw new InvalidOperationException(
                $"{plugin.Name} holds {identity.FormKey}, but no document in its source tree carries it.");

        using var document = JsonDocument.Parse(carrier.Body);
        return _containers.Value.ContainmentOf(carrier.RecordType, document.RootElement, identity.FormKey);
    }

    /// <summary>Where this plugin puts the cell <paramref name="identity"/> names, or null when it is
    /// not a cell this plugin holds.</summary>
    internal CellPlacement? CellPlacementOf(RecordIdentity identity)
    {
        if (_tree != null) return _tree.CellPlacementOf(plugin, identity);

        return Loaded()?.CellStructureOf(identity.FormKey) is { } cell
            ? new CellPlacement(cell.ParentWorldspace, cell.BlockX, cell.BlockY, cell.SubX, cell.SubY, cell.IsInterior)
            : null;
    }

    public void Dispose() => _loaded?.Dispose();

    // Null when the load order registers no such copy: it holds nothing, which is an answer.
    private IPluginRecordLookup? Loaded()
    {
        if (_opened) return _loaded;
        _opened = true;
        if (loadOrder.Copy(plugin) is { } copy)
            _loaded = adapter.OpenRecordLookup(copy, _release, _schemas);
        return _loaded;
    }

    private InvalidOperationException NoLongerHeld(string formKey) =>
        new($"{plugin.Name} stopped holding {formKey} mid-copy.");
}
