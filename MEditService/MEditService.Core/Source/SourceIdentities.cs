using System.Text.Json;
using MEditService.Core.Records;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>Which record a FormKey names in one plugin's working tree, for a caller holding no
/// identity. <see cref="SourceUnitResolver"/> runs the other way and cannot be asked without the
/// record type it looks for.</summary>
internal static class SourceIdentities
{
    /// <summary>What the tree holds at <paramref name="formKey"/>, or null when no document carries
    /// it. The record type comes from where the document sits and the EditorID from inside it, never
    /// a file name another tool renamed.</summary>
    internal static RecordIdentity? Of(
        string modFolder, string pluginFileName, string formKey, GameRelease release)
    {
        var root = SourceDocuments.RootIn(modFolder, pluginFileName);
        if (!Directory.Exists(root)) return null;

        // The header's document is the fixed root RecordData.json, and its FormKey is computed rather
        // than declared, so no name in the tree carries it.
        if (formKey.Equals(HeaderIndexer.FormKeyFor(ModKey.FromFileName(pluginFileName)), StringComparison.Ordinal))
        {
            return File.Exists(Path.Combine(root, SourceUnitResolver.RecordDataFileName))
                ? new RecordIdentity(formKey, HeaderIndexer.RecordType, null)
                : null;
        }

        foreach (var entry in Directory.EnumerateFileSystemEntries(root, "*", SearchOption.AllDirectories))
        {
            if (!SourceUnitResolver.NameCarriesFormKey(Path.GetFileName(entry), formKey)) continue;

            // A directory whose name carries the FormKey holds the record in its RecordData.json; a
            // file whose name carries it is the record.
            var document = Directory.Exists(entry) ? Path.Combine(entry, SourceUnitResolver.RecordDataFileName) : entry;
            if (!File.Exists(document)) continue;
            if (EmbeddedOwners.RecordTypeOf(Path.GetRelativePath(modFolder, document), release) is not { } recordType)
                continue;

            // The name is the index; the document is the answer. A name the document contradicts is
            // stale, and the record it claims is elsewhere or gone.
            if (Declared(document) is not ({ } declaredFormKey, var editorId)
                || !declaredFormKey.Equals(formKey, StringComparison.Ordinal))
            {
                continue;
            }

            return new RecordIdentity(formKey, recordType, editorId);
        }

        return null;
    }

    // The root object's own two members, from the one read. Never exclusive owners of the file: it
    // may be gone, locked or half-written since the listing.
    private static (string? FormKey, string? EditorId) Declared(string document)
    {
        try
        {
            using var parsed = JsonDocument.Parse(SourceUnitResolver.StripUtf8Bom(File.ReadAllBytes(document)));
            if (parsed.RootElement.ValueKind != JsonValueKind.Object) return (null, null);

            return (Text(parsed.RootElement, "FormKey"), Text(parsed.RootElement, "EditorID"));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return (null, null);
        }
    }

    private static string? Text(JsonElement root, string member) =>
        root.TryGetProperty(member, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
}
