using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A document and the name it goes by, which is the leaf name a flat record's file
/// takes.</summary>
public readonly record struct NamedDocument(string Text, string? EditorId);

/// <summary>A record's own identity and links changed as documents: the codec reads the text, edits
/// the graph it built, and writes the text back, so no caller holds the record (ADR-0005
/// rule 2).</summary>
public static class RecordDocumentEdits
{
    /// <summary>The record under <paramref name="newFormKey"/> with every child slot cleared and its
    /// EditorID replaced through <paramref name="deriveEditorId"/> — what Copy as New Record lands
    /// for a record with a group of its own.</summary>
    public static NamedDocument DuplicatedWithoutChildren(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey,
        Func<string?, string?> deriveEditorId)
    {
        var duplicate = Duplicated(codec, text, release, recordType, newFormKey);
        duplicate.EditorID = deriveEditorId(duplicate.EditorID);
        ContainerChildFields.ClearAllChildSlots(duplicate);
        return Named(codec, duplicate, release);
    }

    /// <summary>Every record the document carries inline, outermost first: the descendants a copy
    /// has to draw a fresh FormKey for before it can duplicate the subtree.</summary>
    public static IReadOnlyList<string> EmbeddedDescendantFormKeys(
        RecordTextCodec codec, string text, GameRelease release, string? recordType) =>
        [.. EmbeddedDescendants(codec.Deserialize(text, release, recordType))
            .Select(child => child.FormKey.ToString())];

    /// <summary>The record under <paramref name="newFormKey"/> carrying its whole embedded subtree,
    /// each descendant re-keyed by <paramref name="rekeys"/> with its own self-link moved with it,
    /// and every EditorID replaced through <paramref name="deriveEditorId"/>.</summary>
    public static NamedDocument DuplicatedWithSubtreeRekeyed(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey,
        IReadOnlyDictionary<string, string> rekeys, Func<string?, string?> deriveEditorId)
    {
        var duplicate = Duplicated(codec, text, release, recordType, newFormKey);
        duplicate.EditorID = deriveEditorId(duplicate.EditorID);
        // Links between copied siblings are left alone, which is xEdit's own behavior.
        foreach (var child in EmbeddedDescendants(duplicate))
        {
            var oldFormKey = child.FormKey.ToString();
            if (!rekeys.TryGetValue(oldFormKey, out var childFormKey))
            {
                throw new InvalidOperationException(
                    $"The duplicate of {newFormKey} embeds {oldFormKey}, which "
                    + $"{nameof(EmbeddedDescendantFormKeys)} did not name, so no fresh FormKey was drawn for it. "
                    + "Copying it would land two records under one key.");
            }

            child.FormKey = FormKey.Factory(childFormKey);
            child.EditorID = deriveEditorId(child.EditorID);
            RemapSelfLink(child, oldFormKey, childFormKey);
        }
        return Named(codec, duplicate, release);
    }

    /// <summary>The record under <paramref name="newFormKey"/> and otherwise as it was: what a
    /// renumber writes for the record it was asked about.</summary>
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

        ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);
        return codec.SerializeToText(owner, release);
    }

    private static NamedDocument Named(RecordTextCodec codec, IMajorRecordGetter record, GameRelease release) =>
        new(codec.SerializeToText(record, release), record.EditorID);

    private static MajorRecord Duplicated(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey)
    {
        var source = codec.Deserialize(text, release, recordType);
        var oldFormKey = source.FormKey.ToString();
        var duplicate = source.Duplicate(FormKey.Factory(newFormKey));
        RemapSelfLink(duplicate, oldFormKey, newFormKey);
        return duplicate;
    }

    // Embedded slots at every level: a worldspace embeds its top cell, which embeds its placed
    // references, while its blocks have directories of their own and are nobody's document.
    private static IEnumerable<IMajorRecordInternal> EmbeddedDescendants(IMajorRecordGetter container)
    {
        var containerType = ContainerChildFields.NormalizedTypeName(container.GetType());
        foreach (var (slotName, _, child) in ContainerChildFields.EnumerateChildren(container).ToList())
        {
            if (!ContainerChildFields.EmbeddedSlots.Contains((containerType, slotName))) continue;

            yield return (IMajorRecordInternal)child;
            foreach (var deeper in EmbeddedDescendants(child)) yield return deeper;
        }
    }

    // A record holding no links at all is left alone: a duplicate's self-link is optional.
    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links) links.RemapLinks(Mapping(oldFormKey, newFormKey));
    }

    private static Dictionary<FormKey, FormKey> Mapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };
}
