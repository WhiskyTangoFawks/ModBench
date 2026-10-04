using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

/// <summary>How the text of a document changes under a new FormKey: a record's own, or an embedded
/// child inside its owner's (null when the owner does not carry it).</summary>
public sealed record DocumentRekey(
    Func<SourceDocument, string, string> Own, Func<SourceDocument, string, string, string?> ChildOfOwner);

public sealed partial class SourceRepository
{
    /// <summary>The document a FormKey change writes: the record's own under its new key, or the
    /// owner's text with the embedded child under it. Throws when no readable document carries the
    /// record.</summary>
    internal SourceDocument RekeyedDocument(
        PluginAddress plugin, RecordIdentity identity, string newFormKey,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, DocumentRekey rekey)
    {
        var carrying = ContainerDocument(plugin, identity, schemas)
            ?? throw new InvalidOperationException(
                $"No readable document in {plugin.Name}'s tree carries {identity.FormKey}.");

        if (carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            return new SourceDocument(
                newFormKey, identity.RecordType, identity.EditorId,
                rekey.Own(carrying, newFormKey));
        }

        var ownerText = rekey.ChildOfOwner(carrying, identity.FormKey, newFormKey)
            ?? throw new InvalidOperationException(
                $"{RelativePathOf(plugin, identity)} was found holding {identity.FormKey}, but its own text does not carry it.");
        return carrying with { Body = ownerText };
    }
}
