using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Serialization;

/// <summary>A container's child slots changed as documents: the codec reads the text, edits the
/// graph it built, and writes the text back, so no caller holds the record (ADR-0032 rule 2).</summary>
internal static class ContainerDocumentEdits
{
    /// <summary>The record's own fields alone, every child slot cleared — what an own-fields copy
    /// lands.</summary>
    internal static string WithoutChildren(
        RecordTextCodec codec, string text, GameRelease release, string? recordType)
    {
        var record = codec.Deserialize(text, release, recordType);
        ContainerChildFields.ClearAllChildSlots(record);
        return codec.SerializeToText(record, release);
    }

    /// <summary>The owner's text with <paramref name="childText"/> appended to
    /// <paramref name="slotName"/> of <paramref name="containerFormKey"/> — the owner, or a
    /// container its document carries inline. Null when the text carries neither.</summary>
    internal static string? WithChildAppended(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string containerFormKey, string slotName, string childText, string? childRecordType)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        if (ContainerIn(owner, containerFormKey) is not { } container) return null;

        ContainerChildFields.AddChildToSlot(
            container, slotName, codec.Deserialize(childText, release, childRecordType));
        return codec.SerializeToText(owner, release);
    }

    /// <summary>The owner's text with the child <paramref name="formKey"/> names replaced at its own
    /// slot position, keeping that child's own children. Null when the text carries no such
    /// child.</summary>
    internal static string? WithChildReplaced(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string formKey, string replacementText, string? replacementRecordType)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        if (ContainerChildFields.FindEmbeddedChild(owner, formKey) is not { } found) return null;

        var replacement = codec.Deserialize(replacementText, release, replacementRecordType);
        ContainerChildFields.TransplantChildSlots(found.Child, replacement);
        ContainerChildFields.ReplaceInSlot(found.Parent, found.SlotName, found.SlotIndex, replacement);
        return codec.SerializeToText(owner, release);
    }

    private static IMajorRecordGetter? ContainerIn(IMajorRecord owner, string containerFormKey) =>
        owner.FormKey.ToString().Equals(containerFormKey, StringComparison.Ordinal)
            ? owner
            : ContainerChildFields.FindEmbeddedChild(owner, containerFormKey)?.Child;
}
