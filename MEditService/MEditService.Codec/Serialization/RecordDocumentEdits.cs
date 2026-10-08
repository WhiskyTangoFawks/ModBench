using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A document and the name it goes by, which is the leaf name a flat record's file
/// takes.</summary>
public readonly record struct NamedDocument(string Text, string? EditorId);

/// <summary>A record's own identity and links changed as documents: the codec reads the text, edits
/// the graph it built, and writes the text back (ADR-0005).</summary>
public static class RecordDocumentEdits
{
    /// <summary>The record under <paramref name="newFormKey"/> with every child slot cleared and its
    /// EditorID replaced through <paramref name="deriveEditorId"/> — what Copy as New Record lands.</summary>
    public static NamedDocument DuplicatedWithoutChildren(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey,
        Func<string?, string?> deriveEditorId)
    {
        var source = codec.Deserialize(text, release, recordType);
        var duplicate = source.Duplicate(FormKey.Factory(newFormKey));
        RemapSelfLink(duplicate, source.FormKey.ToString(), newFormKey);
        duplicate.EditorID = deriveEditorId(duplicate.EditorID);
        ContainerChildFields.ClearAllChildSlots(duplicate);
        return Named(codec, duplicate, release);
    }

    /// <summary>The record under <paramref name="newFormKey"/> and otherwise as it was: what a
    /// FormID edit writes for the record it was asked about.</summary>
    public static string WithFormKey(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey)
    {
        var record = codec.Deserialize(text, release, recordType);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);
        return codec.SerializeToText(record, release);
    }

    /// <summary>The owner's text with the embedded child <paramref name="oldFormKey"/> under
    /// <paramref name="newFormKey"/>, and nothing else changed. Null when the text carries no such
    /// child.</summary>
    public static string? WithEmbeddedChildFormKey(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string oldFormKey, string newFormKey)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found) return null;

        ((IMajorRecordInternal)found).FormKey = FormKey.Factory(newFormKey);
        return codec.SerializeToText(owner, release);
    }

    private static NamedDocument Named(RecordTextCodec codec, IMajorRecordGetter record, GameRelease release) =>
        new(codec.SerializeToText(record, release), record.EditorID);

    // A record holding no links at all is left alone: a duplicate's self-link is optional.
    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links) links.RemapLinks(Mapping(oldFormKey, newFormKey));
    }

    private static Dictionary<FormKey, FormKey> Mapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };
}
