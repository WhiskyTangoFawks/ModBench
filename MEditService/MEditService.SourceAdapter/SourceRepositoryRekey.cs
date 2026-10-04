using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;

namespace MEditService.SourceAdapter;

public sealed partial class SourceRepository
{
    /// <summary>The document a FormKey change writes: the record's own under its new key, or the
    /// owner's text with the embedded child under it. Throws when no readable document carries the
    /// record.</summary>
    internal SourceDocument RekeyedDocument(
        PluginAddress plugin, RecordIdentity identity, string newFormKey,
        IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTextCodec codec)
    {
        var carrying = ContainerDocument(plugin, identity, schemas)
            ?? throw new InvalidOperationException(
                $"No readable document in {plugin.Name}'s tree carries {identity.FormKey}. Nothing was written.");

        if (carrying.FormKey.Equals(identity.FormKey, StringComparison.Ordinal))
        {
            return new SourceDocument(
                newFormKey, identity.RecordType, identity.EditorId,
                RecordDocumentEdits.WithFormKey(codec, carrying.Body, _release, carrying.RecordType, newFormKey));
        }

        var ownerText = RecordDocumentEdits.WithEmbeddedChildFormKey(
                codec, carrying.Body, _release, carrying.RecordType, identity.FormKey, newFormKey)
            ?? throw new InvalidOperationException(
                $"{RelativePathOf(plugin, identity)} was found holding {identity.FormKey}, but its own text does not carry it. " +
                "Nothing was written.");
        return carrying with { Body = ownerText };
    }
}
