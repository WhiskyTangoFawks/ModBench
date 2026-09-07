using System.Text;
using System.Text.Json;
using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>Which record the file at a path declares, and where a plugin's documents live. The
/// reverse of <see cref="SourceRepository.Locate"/>, whose question is which file a record lives
/// in.</summary>
public static class SourceDocuments
{
    private const string JsonSuffix = ".json";

    /// <summary>The folder holding <paramref name="pluginFileName"/>'s documents. It need not exist:
    /// an untracked mod has none until Track writes one.</summary>
    public static string RootIn(string modFolder, string pluginFileName) =>
        Path.Combine(modFolder, SourceRecordPath.RootFor(pluginFileName));

    /// <summary>True for a file under the source root that holds no record — group and block metadata,
    /// and anything that is not a document at all. No row is derived from one.</summary>
    public static bool CarriesNoRecord(string filePath) =>
        !filePath.EndsWith(JsonSuffix, StringComparison.OrdinalIgnoreCase)
        || Path.GetFileName(filePath).Equals(SourceUnitResolver.GroupRecordDataFileName, StringComparison.Ordinal);

    /// <summary>The FormKey the document at <paramref name="filePath"/> declares — an embedded child's
    /// owner's, since the file is the owner's document. Null when it cannot be read or declares
    /// none.</summary>
    public static string? FormKeyDeclaredBy(string filePath, string modFolder, string pluginFileName)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(filePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Never exclusive owners of the file: it may have been deleted, moved or locked between
            // the event and this read.
            return null;
        }

        return FormKeyDeclaredIn(
            Encoding.UTF8.GetString(SourceUnitResolver.StripUtf8Bom(bytes)),
            filePath, HeaderDocumentIn(modFolder, pluginFileName), pluginFileName);
    }

    /// <summary>The plugin header's own document: the whole-mod door's root RecordData.json.</summary>
    internal static string HeaderDocumentIn(string modFolder, string pluginFileName) =>
        Path.Combine(RootIn(modFolder, pluginFileName), SourceUnitResolver.RecordDataFileName);

    /// <summary>The same answer for a caller holding the text already, so a whole-tree pass reads each
    /// file once.</summary>
    internal static string? FormKeyDeclaredIn(
        string text, string filePath, string headerDocumentPath, string pluginFileName)
    {
        // The header's document carries a ModKey rather than a FormKey; HeaderIndexer computes the
        // FormKey the index files it under.
        if (filePath.Equals(headerDocumentPath, StringComparison.Ordinal))
            return HeaderIndexer.FormKeyFor(ModKey.FromFileName(pluginFileName));

        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty("FormKey", out var formKey)
                   && formKey.ValueKind == JsonValueKind.String
                ? formKey.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
