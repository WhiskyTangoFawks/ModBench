using MEditService.Core.PluginAdapter;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Edits;

/// <summary>What a copy reads of the record it is copying (ADR-0046 invariant 7): a tracked source
/// answers from its working tree, an untracked one from the loaded copy through the codec. One per
/// gesture, not thread-safe.</summary>
internal sealed class CopySource(
    PluginKey plugin, LoadOrder loadOrder, IPluginAdapter importer, RecordTextCodec codec, SchemaReflector schemaReflector)
    : IDisposable
{
    /// <summary>The container whose document carries a record, and the slot it sits in: a placed
    /// reference in its cell, a response in its topic, a topic in its quest.</summary>
    internal readonly record struct Containment(string ParentFormKey, string ParentRecordType, string SlotName);

    private readonly GameRelease _release = loadOrder.GameRelease;

    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas =
        schemaReflector.GetSchemas(loadOrder.GameRelease);

    // Tracked is the one condition under which a plugin has source text at all.
    private readonly SourceRepository? _tree = ModFolders.TrackedOf(loadOrder, plugin) is { } modFolder
        ? SourceRepository.Open(modFolder, loadOrder.GameRelease)
        : null;

    private (ILoadedMod Mod, ILinkCache Cache)? _loaded;
    private bool _opened;
    private Dictionary<string, Containment>? _containments;
    private Dictionary<string, CellPlacement>? _cells;

    internal PluginKey Plugin => plugin;

    /// <summary>The record type and EditorID this plugin's copy names <paramref name="formKey"/>, or
    /// null when it holds nothing under that key.</summary>
    internal RecordIdentity? Identity(string formKey)
    {
        if (_tree != null) return _tree.IdentityOf(plugin, formKey, _schemas);

        return Getter(formKey) is { } record
            ? new RecordIdentity(record.FormKey.ToString(), RecordTableName.Of(record, _schemas), record.EditorID)
            : null;
    }

    /// <summary>The record's own text: the working tree's own bytes when tracked, otherwise the loaded
    /// copy's record through the codec — byte for byte what Track would have written.</summary>
    internal string Body(RecordIdentity identity)
    {
        if (_tree == null)
        {
            var record = Getter(identity.FormKey) ?? throw NoLongerHeld(identity.FormKey);
            return codec.SerializeToText(record, _release);
        }

        var body = _tree.Get(plugin, identity)?.Body ?? throw NoLongerHeld(identity.FormKey);
        // Read through the codec even though the verbatim bytes are what lands: a copy of text no
        // reader can make a record of would leave the destination uncompilable.
        codec.Deserialize(body, _release, identity.RecordType);
        return body;
    }

    /// <summary>The reader's own words for a record it cannot read: the codec's message for a working
    /// tree's document, the diagnosis Track uses for a plugin's own file.</summary>
    internal string Diagnose(Exception ex) =>
        _tree != null ? ex.Message : PluginDiagnosis.FromParseException(ex).Describe();

    /// <summary>The record's graph, read back through the codec from its own text, so what a copy
    /// mutates is a document rather than the source's live object.</summary>
    internal IMajorRecord Record(RecordIdentity identity) =>
        codec.Deserialize(Body(identity), _release, identity.RecordType);

    /// <summary>The container carrying this record, or null when it has a document of its own. A cell
    /// always answers null: its place is <see cref="CellPlacementOf"/>'s, never a slot's.</summary>
    internal Containment? ContainerOf(RecordIdentity identity)
    {
        if (RecordTypeDispatch.For(_release).IsCell(identity.RecordType)) return null;

        if (_tree == null)
            return Containments().TryGetValue(identity.FormKey, out var found) ? found : null;

        if (_tree.Locate(plugin, identity) is not { IsEmbedded: true } unit) return null;
        var owner = codec.DeserializeAsync(unit.FullPath, _release, unit.OwnerRecordType).GetAwaiter().GetResult();
        if (ContainerChildFields.FindEmbeddedChild(owner, identity.FormKey) is not { } embedded) return null;

        return new Containment(
            embedded.Parent.FormKey.ToString(),
            RecordTableName.Of(embedded.Parent, _schemas),
            embedded.SlotName);
    }

    /// <summary>Where this plugin puts the cell <paramref name="identity"/> names, or null when it is
    /// not a cell this plugin holds.</summary>
    internal CellPlacement? CellPlacementOf(RecordIdentity identity)
    {
        if (_tree != null) return _tree.CellPlacementOf(plugin, identity);
        return Cells().TryGetValue(identity.FormKey, out var placement) ? placement : null;
    }

    public void Dispose()
    {
        _loaded?.Cache.Dispose();
        _loaded?.Mod.Dispose();
    }

    // Every child slot names its parent, which is what the tracked branch reads out of the owner
    // document. A block is not a record, so a worldspace's cells are not here.
    private Dictionary<string, Containment> Containments()
    {
        if (_containments != null) return _containments;

        _containments = new Dictionary<string, Containment>(StringComparer.Ordinal);
        if (Mod() is not { } mod) return _containments;

        foreach (var record in mod.EnumerateMajorRecords())
        {
            var parentType = RecordTableName.Of(record, _schemas);
            foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(record))
            {
                _containments.TryAdd(
                    child.FormKey.ToString(),
                    new Containment(record.FormKey.ToString(), parentType, slotName));
            }
        }
        return _containments;
    }

    // The GRUP hierarchy EnumerateMajorRecords flattens away.
    private Dictionary<string, CellPlacement> Cells()
    {
        if (_cells != null) return _cells;

        _cells = new Dictionary<string, CellPlacement>(StringComparer.Ordinal);
        if (Mod() is not { } mod) return _cells;

        foreach (var (formKey, cell) in ModDocuments.CellStructuresOf(mod))
        {
            _cells[formKey] = new CellPlacement(
                cell.ParentWorldspace, cell.BlockX, cell.BlockY, cell.SubX, cell.SubY, cell.IsInterior);
        }
        return _cells;
    }

    private IMajorRecordGetter? Getter(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed) && Loaded() is { } loaded
        && loaded.Cache.TryResolve<IMajorRecordGetter>(parsed, out var record)
            ? record
            : null;

    private IModGetter? Mod() => Loaded()?.Mod.Getter;

    // Null when the load order registers no such copy: it holds nothing, which is an answer.
    private (ILoadedMod Mod, ILinkCache Cache)? Loaded()
    {
        if (_opened) return _loaded;
        _opened = true;
        if (loadOrder.Copy(plugin) is { } copy)
        {
            var mod = importer.Open(copy, _release);
            _loaded = (mod, mod.Getter.ToUntypedImmutableLinkCache());
        }
        return _loaded;
    }

    private InvalidOperationException NoLongerHeld(string formKey) =>
        new($"{plugin.Name} stopped holding {formKey} mid-copy.");
}
