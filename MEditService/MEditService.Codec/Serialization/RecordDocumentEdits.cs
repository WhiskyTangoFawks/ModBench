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
    /// <summary>The record under <paramref name="newFormKey"/> with every child slot cleared — what
    /// Copy as New Record lands for a record with a group of its own.</summary>
    public static NamedDocument DuplicatedWithoutChildren(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey)
    {
        var duplicate = Duplicated(codec, text, release, recordType, newFormKey);
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
    /// each descendant re-keyed by <paramref name="rekeys"/> with its own self-link moved with
    /// it.</summary>
    public static NamedDocument DuplicatedWithSubtreeRekeyed(
        RecordTextCodec codec, string text, GameRelease release, string? recordType, string newFormKey,
        IReadOnlyDictionary<string, string> rekeys)
    {
        var duplicate = Duplicated(codec, text, release, recordType, newFormKey);
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
            RemapSelfLink(child, oldFormKey, childFormKey);
        }
        return Named(codec, duplicate, release);
    }

    /// <summary>Every link to <paramref name="oldFormKey"/> moved to <paramref name="newFormKey"/>
    /// and the record's own key left where it is — what a renumber writes for a document that
    /// references the record being renumbered.</summary>
    public static string WithLinksRemapped(
        RecordTextCodec codec, string text, GameRelease release, string? recordType,
        string oldFormKey, string newFormKey)
    {
        var record = codec.Deserialize(text, release, recordType);
        RemapLinks(record, oldFormKey, newFormKey);
        return codec.SerializeToText(record, release);
    }

    /// <summary>The record moved to <paramref name="newFormKey"/>, its links included — what a
    /// renumber writes for the record it was asked about.</summary>
    public static string WithSelfRenumbered(
        RecordTextCodec codec, string text, GameRelease release, string? recordType,
        string oldFormKey, string newFormKey)
    {
        var record = codec.Deserialize(text, release, recordType);
        RemapLinks(record, oldFormKey, newFormKey);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);
        return codec.SerializeToText(record, release);
    }

    /// <summary>The owner's text with the embedded child <paramref name="oldFormKey"/> names moved
    /// to <paramref name="newFormKey"/>, and that child's own document. Null when the text carries
    /// no such child.</summary>
    public static (string Text, string ChildText)? WithEmbeddedChildRenumbered(
        RecordTextCodec codec, string ownerText, GameRelease release, string? ownerRecordType,
        string oldFormKey, string newFormKey)
    {
        var owner = codec.Deserialize(ownerText, release, ownerRecordType);
        if (ContainerChildFields.FindEmbeddedChild(owner, oldFormKey) is not { } found) return null;

        // Remapped on the owner, not the child: a sibling embedded in the same document may hold
        // the self-link, and its own file is this same one.
        RemapLinks(owner, oldFormKey, newFormKey);
        ((IMajorRecordInternal)found.Child).FormKey = FormKey.Factory(newFormKey);

        return (codec.SerializeToText(owner, release), codec.SerializeToText(found.Child, release));
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

    // A record holding no links at all is left alone rather than refused: a duplicate's self-link
    // is optional, unlike a renumber's remap.
    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links) links.RemapLinks(Mapping(oldFormKey, newFormKey));
    }

    private static void RemapLinks(IMajorRecord record, string oldFormKey, string newFormKey) =>
        ((IFormLinkContainer)record).RemapLinks(Mapping(oldFormKey, newFormKey));

    private static Dictionary<FormKey, FormKey> Mapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };
}
