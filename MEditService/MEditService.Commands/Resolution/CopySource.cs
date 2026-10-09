using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;

namespace MEditService.Commands.Resolution;

/// <summary>What a copy reads of the record it is copying (ADR-0015). One per gesture,
/// not thread-safe.</summary>
internal sealed class CopySource(
    PluginAddress plugin, LoadOrderSnapshot loadOrder, IPluginAdapter adapter, SchemaReflector schemaReflector,
    WriteSessions sessions)
    : IDisposable
{
    private readonly GameRelease _release = loadOrder.GameRelease;

    private readonly IReadOnlyDictionary<string, RecordTableSchema> _schemas =
        schemaReflector.GetSchemas(loadOrder.GameRelease);

    private readonly SourceRepository? _tree = loadOrder.Plugin(plugin) is { Provider: PluginProvider.FromMod mod } registered
        && SourceRepository.SourceReads(registered)
        ? sessions.Over(mod, loadOrder.GameRelease).Repository
        : null;

    private IPluginRecords? _records;
    private string? _unopened;
    private bool _opened;

    internal PluginAddress Plugin => plugin;

    internal LoadOrderSnapshot Snapshot => loadOrder;

    internal WriteSessions Sessions => sessions;

    /// <summary>The record type and EditorID this plugin's copy names <paramref name="formKey"/>, or
    /// null when it holds nothing under that key. A tracked document that is no record document is
    /// unreadable, not none.</summary>
    internal CopyRead<RecordIdentity?> Identity(string formKey) =>
        _tree is { } tree
            ? CopyRead<RecordIdentity?>.Of(tree.Get(plugin, formKey).Then(held => SourceAnswer.Of(held?.Identity)))
            : FromFile(records => records.IdentityOf(formKey));

    /// <summary>The record header's flags, read without the record's fields.</summary>
    internal CopyRead<long> RecordFlags(RecordIdentity identity)
    {
        if (_tree is not { } tree)
            return FromFile(records => records.RecordFlagsOf(identity.FormKey)).Then<long>(flags => flags ?? throw NoLongerHeld(identity.FormKey));
        return BodyInTheTree(tree, identity).Then<long>(body =>
            Codec.Serialization.Document.TryRead(body, out var document, out var whyNot) ? RecordFlagsWrite.HeldBy(document) : CopyRead<long>.Unreadable(whyNot));
    }

    /// <summary>Whether the record's header carries Partial Form, on a type that can.</summary>
    internal CopyRead<bool> IsPartialForm(RecordIdentity identity)
    {
        if (!RecordTypes.For(_release).HasChildSlots(identity.RecordType)) return false;
        return RecordFlags(identity).Then<bool>(flags => (flags & PartialFormFlag.Bit) != 0);
    }

    /// <summary>The record's own text: the working tree's own bytes when tracked, otherwise the loaded
    /// plugin's record through the codec — byte for byte what Track would have written.</summary>
    internal CopyRead<string> Body(RecordIdentity identity)
    {
        if (_tree is not { } tree)
            return FromFile(records => records.TextOf(identity.FormKey)).Then<string>(text => text ?? throw NoLongerHeld(identity.FormKey));

        return BodyInTheTree(tree, identity).Then<string>(body =>
        {
            // Read through the codec even though the verbatim bytes land: a copy of text no reader can
            // make a record of would leave the destination uncompilable. The codec answers such text by
            // throwing, in Mutagen's open-ended ways.
            try
            {
                RecordTextCodec.RoundTrip(body, _release, identity.RecordType);
                return body;
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                return CopyRead<string>.Unreadable(ex.Message);
            }
        });
    }

    /// <summary>The record's own text under the identity a copy files it by, which is what the
    /// destination writes and what the container rule appends.</summary>
    internal CopyRead<SourceDocument> Document(RecordIdentity identity) =>
        Body(identity).Then<SourceDocument>(body => new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, body));

    /// <summary>The container of this record, or null when it has none. A
    /// worldspace's persistent cell answers its worldspace.</summary>
    internal CopyRead<DocumentContainment?> ContainerOf(RecordIdentity identity) =>
        _tree is { } tree
            ? CopyRead<DocumentContainment?>.Of(tree.ContainerOf(plugin, identity))
            : FromFile(records => records.ContainmentOf(identity.FormKey));

    /// <summary>The worldspace the cell <paramref name="identity"/> names sits in, or null for an interior
    /// cell or a cell this plugin does not hold.</summary>
    internal CopyRead<string?> WorldspaceOf(RecordIdentity identity) =>
        _tree is { } tree
            ? CopyRead<string?>.Of(tree.WorldspaceOf(plugin, identity))
            : FromFile(records => records.CellStructureOf(identity.FormKey)).Then<string?>(cell => cell?.ParentWorldspace);

    /// <summary>How many records sit above this one: its containers, and a numbered cell's worldspace.
    /// An unreadable record ends the count where it stood; its own copy refuses it, naming why.</summary>
    internal int ContainmentDepth(string formKey)
    {
        var depth = 0;
        var identity = Identity(formKey);
        while (identity.Holds(out var held, out _) && held is { } record
               && ParentOf(record).Holds(out var parent, out _) && parent is { } above)
        {
            depth++;
            identity = Identity(above);
        }
        return depth;
    }

    private CopyRead<string?> ParentOf(RecordIdentity identity) =>
        ContainerOf(identity).Then(container =>
        {
            if (container is { } held) return held.ParentFormKey;
            return RecordTypes.For(_release).IsCell(identity.RecordType) ? WorldspaceOf(identity) : (string?)null;
        });

    /// <summary>The exterior cell this plugin holds at grid (<paramref name="x"/>, <paramref name="y"/>)
    /// of <paramref name="worldspace"/>, or null when it holds none there.</summary>
    internal CopyRead<RecordIdentity?> CellAt(string worldspace, int x, int y) =>
        _tree is { } tree
            ? CopyRead<RecordIdentity?>.Of(tree.GetCellAt(plugin, worldspace, x, y).Then(cell => SourceAnswer.Of(cell?.Identity)))
            : FromFile(records => records.CellAt(worldspace, x, y))
                .Then(formKey => formKey is null ? (RecordIdentity?)null : Identity(formKey));

    public void Dispose() => _records?.Dispose();

    private CopyRead<string> BodyInTheTree(SourceRepository tree, RecordIdentity identity) =>
        CopyRead<SourceDocument?>.Of(tree.RecordOf(plugin, identity))
            .Then<string>(held => held?.Body ?? throw NoLongerHeld(identity.FormKey));

    // A plugin the load order does not register holds nothing, which is an answer.
    private CopyRead<T?> FromFile<T>(Func<IPluginRecords, Answer<T?, PluginFailure>> read)
    {
        if (loadOrder.Plugin(plugin) is not { } registered) return default(T);
        if (!_opened)
        {
            _opened = true;
            if (adapter.OpenRecordLookup(registered, _release, _schemas).Holds(out var records, out var failure)) _records = records;
            else _unopened = failure.Reason;
        }
        return _records is { } opened
            ? CopyRead<T?>.Of(read(opened))
            : CopyRead<T?>.Unreadable(_unopened ?? throw new InvalidOperationException("Expected an open that failed to say why."));
    }

    private InvalidOperationException NoLongerHeld(string formKey) =>
        new($"{plugin.Name} stopped holding {formKey} mid-copy.");
}
