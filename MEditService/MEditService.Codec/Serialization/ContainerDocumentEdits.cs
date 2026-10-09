using Mutagen.Bethesda;

namespace MEditService.Codec.Serialization;

/// <summary>A container's child slots changed in its text: an append or a copy goes through the graph the
/// codec reads, and a child's read, replace or cut splices only the child's span (ADR-0005).</summary>
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

    /// <summary>The child's text for a caller holding the owner and asking by identity. Null when no
    /// embedded slot of the owner carries <paramref name="formKey"/>.</summary>
    public static string? ChildTextOf(byte[] ownerBytes, string? ownerRecordType, string formKey, GameRelease release) =>
        EmbeddedChildSplice.TextOf(ownerBytes, ownerRecordType, formKey, release);

    /// <summary>The child's own text as the codec spells it standalone.</summary>
    public static string ChildTextAt(byte[] ownerBytes, EmbeddedChildSpan span, GameRelease release) =>
        EmbeddedChildSplice.Extract(ownerBytes, span, release);

    /// <summary>The owner's text with <paramref name="childText"/> in the child's place and no other byte changed.</summary>
    public static string WithChildReplaced(byte[] ownerBytes, EmbeddedChildSpan span, string childText) =>
        EmbeddedChildSplice.Replace(ownerBytes, span, childText);

    /// <summary>The owner's text without the child, and without its slot when it was all the slot held.</summary>
    public static string WithChildCut(byte[] ownerBytes, EmbeddedChildSpan span) =>
        EmbeddedChildSplice.Cut(ownerBytes, span);
}
