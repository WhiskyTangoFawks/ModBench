using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Codec.Serialization;

/// <summary>A document and the name it goes by, which is the leaf name a flat record's file
/// takes.</summary>
public readonly record struct NamedDocument(string Text, string? EditorId);

/// <summary>A record's own identity and links changed as documents: the codec reads the text, edits
/// the graph it built, and writes the text back (ADR-0005). A plugin's rename splices its strings
/// into the text.</summary>
public static class RecordDocumentEdits
{
    /// <summary>The record under <paramref name="newFormKey"/> with every child slot cleared and its
    /// EditorID replaced through <paramref name="deriveEditorId"/> — what Copy as New Record lands.</summary>
    public static NamedDocument DuplicatedWithoutChildren(
        string text, GameRelease release, string? recordType, string newFormKey,
        Func<string?, string?> deriveEditorId)
    {
        var source = RecordTextCodec.Deserialize(text, release, recordType);
        var duplicate = source.Duplicate(FormKey.Factory(newFormKey));
        RemapSelfLink(duplicate, source.FormKey.ToString(), newFormKey);
        duplicate.EditorID = deriveEditorId(duplicate.EditorID);
        ContainerChildFields.ClearAllChildSlots(duplicate);
        return Named(duplicate, release);
    }

    /// <summary>The record under <paramref name="newFormKey"/> and otherwise as it was: what a
    /// FormID edit writes for the record it was asked about.</summary>
    public static string WithFormKey(
        string text, GameRelease release, string? recordType, string newFormKey)
    {
        var record = RecordTextCodec.Deserialize(text, release, recordType);
        ((IMajorRecordInternal)record).FormKey = FormKey.Factory(newFormKey);
        return RecordTextCodec.SerializeToText(record, release);
    }

    private static NamedDocument Named(IMajorRecordGetter record, GameRelease release) =>
        new(RecordTextCodec.SerializeToText(record, release), record.EditorID);

    // A record holding no links at all is left alone: a duplicate's self-link is optional.
    private static void RemapSelfLink(IMajorRecordGetter record, string oldFormKey, string newFormKey)
    {
        if (record is IFormLinkContainer links) links.RemapLinks(Mapping(oldFormKey, newFormKey));
    }

    private static Dictionary<FormKey, FormKey> Mapping(string oldFormKey, string newFormKey) =>
        new() { [FormKey.Factory(oldFormKey)] = FormKey.Factory(newFormKey) };

    /// <summary>The document with every FormKey of <paramref name="from"/> (and the header's
    /// ModKey) under <paramref name="to"/>, every other byte as it was. False, with the reader's words, for
    /// text that is no JSON.</summary>
    public static bool TryWithPluginRenamed(
        byte[] text, bool isHeader, ModKey from, ModKey to,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(true)] out byte[]? renamed,
        [System.Diagnostics.CodeAnalysis.NotNullWhen(false)] out string? whyNot)
    {
        try
        {
            (renamed, whyNot) = (PluginRenameSplice.Apply(text, isHeader, from, to), null);
            return true;
        }
        catch (System.Text.Json.JsonException ex)
        {
            (renamed, whyNot) = (null, ex.Message);
            return false;
        }
    }
}
