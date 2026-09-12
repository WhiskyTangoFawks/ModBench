using MEditService.Codec.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A container's child slots changed as documents: the codec reads the text, edits the
/// graph it built, and writes the text back, so no caller holds the record (ADR-0005 rule 2).</summary>
public static class ContainerDocumentEdits
{
    /// <summary>The record's own fields alone, every child slot cleared — what an own-fields copy
    /// lands.</summary>
    public static string WithoutChildren(
        RecordTextCodec codec, string text, GameRelease release, string? recordType)
    {
        var record = codec.Deserialize(text, release, recordType);
        ContainerChildFields.ClearAllChildSlots(record);
        return codec.SerializeToText(record, release);
    }

    /// <summary>The owner's text with <paramref name="childText"/> appended to
    /// <paramref name="slotName"/> of <paramref name="containerFormKey"/> — the owner, or a
    /// container its document carries inline. Null when the text carries neither.</summary>
    public static string? WithChildAppended(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string containerFormKey, string slotName, string childText, string? childRecordType)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        if (ContainerIn(owner, containerFormKey) is not { } container) return null;

        ContainerChildFields.AddChildToSlot(
            container, slotName, codec.Deserialize(childText, release, childRecordType));
        return codec.SerializeToText(owner, release);
    }

    /// <summary><paramref name="destinationText"/> with its own fields replaced by
    /// <paramref name="replacementText"/>'s, keeping the children it already carries. A child with a
    /// document of its own is not one of them: it stays where it is.</summary>
    public static NamedDocument WithOwnFieldsReplaced(
        RecordTextCodec codec, string destinationText, string? destinationRecordType,
        string replacementText, string? replacementRecordType, GameRelease release)
    {
        var replacement = codec.Deserialize(replacementText, release, replacementRecordType);
        ContainerChildFields.ClearAllChildSlots(replacement);

        var destination = codec.Deserialize(destinationText, release, destinationRecordType);
        ContainerChildFields.TransplantChildSlots(destination, replacement);

        return new NamedDocument(codec.SerializeToText(replacement, release), replacement.EditorID);
    }

    /// <summary>The child <paramref name="formKey"/> names inside <paramref name="ownerText"/>, as
    /// its own document under the schema table it belongs to. Null when the text carries no such
    /// child.</summary>
    public static (string RecordType, string Text)? EmbeddedChildIn(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string formKey, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        return ContainerChildFields.FindEmbeddedChild(owner, formKey) is { } found
            ? (RecordTableName.Of(found.Child, schemas), codec.SerializeToText(found.Child, release))
            : null;
    }

    private static IMajorRecordGetter? ContainerIn(IMajorRecord owner, string containerFormKey) =>
        owner.FormKey.ToString().Equals(containerFormKey, StringComparison.Ordinal)
            ? owner
            : ContainerChildFields.FindEmbeddedChild(owner, containerFormKey)?.Child;
}
