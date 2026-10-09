using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>A container's child slots changed as documents: the codec reads the text, edits the
/// graph it built, and writes the text back, or splices in only what an append adds (ADR-0005).</summary>
public static class ContainerDocumentEdits
{
    /// <summary>The record's own fields alone, every child slot cleared — what an own-fields copy
    /// lands.</summary>
    public static string WithoutChildren(
        string text, GameRelease release, string? recordType)
    {
        var record = RecordTextCodec.Deserialize(text, release, recordType);
        ContainerChildFields.ClearAllChildSlots(record);
        return RecordTextCodec.SerializeToText(record, release);
    }

    /// <summary>The container's own text with <paramref name="childText"/> appended to
    /// <paramref name="slotName"/>, and its other bytes as they were.</summary>
    public static ChildAppend WithChildAppended(
        string containerText, GameRelease release, string? containerRecordType,
        string slotName, string childText, string? childRecordType)
    {
        var container = RecordTextCodec.Deserialize(containerText, release, containerRecordType);
        var child = RecordTextCodec.Deserialize(childText, release, childRecordType);
        return ContainerChildFields.TryAddChildToSlot(container, slotName, child, out var held)
            ? new ChildAppend.Appended(ChildTextInsertion.Inserted(containerText, RecordTextCodec.SerializeToBytes(container, release), slotName))
            : new ChildAppend.SlotHeld(held.FormKey.ToString());
    }

    /// <summary><paramref name="destinationText"/> with its own fields replaced by
    /// <paramref name="replacementText"/>'s, keeping the children it already carries. A child with a
    /// document of its own is not one of them: it stays where it is.</summary>
    public static NamedDocument WithOwnFieldsReplaced(
        string destinationText, string? destinationRecordType,
        string replacementText, string? replacementRecordType, GameRelease release)
    {
        var replacement = RecordTextCodec.Deserialize(replacementText, release, replacementRecordType);
        ContainerChildFields.ClearAllChildSlots(replacement);

        var destination = RecordTextCodec.Deserialize(destinationText, release, destinationRecordType);
        ContainerChildFields.TransplantChildSlots(destination, replacement);

        return new NamedDocument(RecordTextCodec.SerializeToText(replacement, release), replacement.EditorID);
    }
}
