using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A container's child slots changed as documents: the codec reads the text, edits the
/// graph it built, and writes the text back (ADR-0005).</summary>
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

    /// <summary>The FormKey of every child record the text carries, at any depth.</summary>
    public static IReadOnlyList<string> ChildFormKeys(
        RecordTextCodec codec, string text, GameRelease release, string? recordType) =>
        [.. DescendantsOf(codec.Deserialize(text, release, recordType)).Select(child => child.FormKey.ToString())];

    /// <summary>The destination's own fields, each source child record overwriting the one held anywhere
    /// in its subtree or in <paramref name="carriedTexts"/>, or added. Throws
    /// <see cref="ChildSlotHeldByAnotherRecordException"/> when a single-valued slot holds another
    /// record.</summary>
    public static string WithChildRecordsMerged(
        RecordTextCodec codec, string destinationText, string? destinationRecordType,
        string sourceText, string? sourceRecordType, GameRelease release,
        IReadOnlyList<(string Text, string? RecordType)>? carriedTexts = null)
    {
        var source = codec.Deserialize(sourceText, release, sourceRecordType);
        var destination = codec.Deserialize(destinationText, release, destinationRecordType);
        var carried = (carriedTexts ?? [])
            .Select(carriedText => (IMajorRecordGetter)codec.Deserialize(carriedText.Text, release, carriedText.RecordType))
            .ToDictionary(record => record.FormKey);
        ContainerChildFields.MergeChildren(
            destination, destination, [.. ContainerChildFields.EnumerateChildren(source).Select(c => (c.SlotName, c.Child))], carried);
        return codec.SerializeToText(destination, release);
    }

    /// <summary>A record the destination holds as a child record of the one copied: the source's own
    /// fields, the children of both merged. Throws as <see cref="WithChildRecordsMerged"/> does.</summary>
    public static NamedDocument WithRecordOverwritten(
        RecordTextCodec codec, string destinationText, string? destinationRecordType,
        string sourceText, string? sourceRecordType, GameRelease release)
    {
        var overwritten = ContainerChildFields.Overwritten(
            codec.Deserialize(destinationText, release, destinationRecordType),
            codec.Deserialize(sourceText, release, sourceRecordType));
        return new NamedDocument(codec.SerializeToText(overwritten, release), overwritten.EditorID);
    }

    private static IEnumerable<IMajorRecordGetter> DescendantsOf(IMajorRecordGetter record) =>
        ContainerChildFields.EnumerateChildren(record)
            .SelectMany(child => DescendantsOf(child.Child).Prepend(child.Child));

    private static IMajorRecordGetter? ContainerIn(IMajorRecord owner, string containerFormKey) =>
        owner.FormKey.ToString().Equals(containerFormKey, StringComparison.Ordinal)
            ? owner
            : ContainerChildFields.FindEmbeddedChild(owner, containerFormKey)?.Child;
}
