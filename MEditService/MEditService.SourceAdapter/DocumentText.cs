using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What a document's text and bytes declare, read as text rather than through the codec. A
/// file may vanish or lock since a listing named it, so a failed read answers null.</summary>
internal static class DocumentText
{
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    internal static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;

    internal static byte[]? BytesOrNull(ISourceFiles files, string path)
    {
        try
        {
            return files.FileExists(path) ? StripUtf8Bom(files.ReadAllBytes(path)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    internal static string? ReadOrNull(ISourceFiles files, string path) =>
        BytesOrNull(files, path) is { } bytes ? Encoding.UTF8.GetString(bytes) : null;

    /// <summary>The FormKey the document at <paramref name="filePath"/> declares — an embedded child's
    /// owner's, since the file is the owner's document. Null when it cannot be read or declares
    /// none.</summary>
    internal static string? FormKeyDeclaredBy(ISourceFiles files, string filePath, string pluginFileName) =>
        ReadOrNull(files, filePath) is { } text ? FormKeyDeclaredIn(text, filePath, pluginFileName) : null;

    /// <summary>The same answer for a caller holding the text already, so a whole-tree pass reads each
    /// file once.</summary>
    internal static string? FormKeyDeclaredIn(string text, string filePath, string pluginFileName) =>
        // The header's document carries a ModKey rather than a FormKey; PluginHeader computes the
        // FormKey the index files it under.
        SourceRepositoryLayout.IsHeaderDocumentPath(filePath, pluginFileName)
            ? SourceRepositoryLayout.HeaderFormKeyOf(pluginFileName)
            : RootStringIn(text, "FormKey");

    // A member of the document's own root object, as a string. Malformed text declares nothing.
    internal static string? RootStringIn(string text, string member)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return document.RootElement.ValueKind == JsonValueKind.Object
                   && document.RootElement.TryGetProperty(member, out var value)
                   && value.ValueKind == JsonValueKind.String
                ? value.GetString()
                : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The EditorID at the document's own root. Malformed text names none.</summary>
    internal static EditorIdRead EditorIdIn(string text)
    {
        try
        {
            using var document = JsonDocument.Parse(text);
            return DocumentNodes.EditorIdOf(document.RootElement);
        }
        catch (JsonException)
        {
            return EditorIdRead.None;
        }
    }

    /// <summary>What the JSON reader says is wrong with <paramref name="text"/>, where it stopped; null
    /// for valid JSON.</summary>
    internal static string? JsonErrorIn(string text)
    {
        try
        {
            using var _ = JsonDocument.Parse(text);
            return null;
        }
        catch (JsonException ex)
        {
            return ex.Message;
        }
    }

    /// <summary>The record's own text out of the bytes <paramref name="unit"/>'s file holds: itself for
    /// a flat record, or spliced back out of its owner's text for an embedded child.</summary>
    internal static string? RecordBodyFromOwnerBytes(
        byte[]? ownerBytes, SourceUnit unit, string formKey, GameRelease release)
    {
        if (ownerBytes == null) return null;

        // File.ReadAllText strips a UTF-8 BOM; raw bytes do not — unstripped, a BOM-carrying file
        // would never compare equal to the codec's BOM-free text.
        ownerBytes = StripUtf8Bom(ownerBytes);

        if (!unit.IsEmbedded) return Encoding.UTF8.GetString(ownerBytes);

        return EmbeddedChildIn(ownerBytes, unit, formKey, release) is { } span
            ? ContainerDocumentEdits.ChildTextAt(ownerBytes, span, release)
            : null;
    }

    /// <summary>Where the owner's text carries the child, with the owner's own type taken from the
    /// record type its path decides — the one fact the text alone cannot supply.</summary>
    internal static EmbeddedChildSpan? EmbeddedChildIn(
        byte[] ownerBytes, SourceUnit unit, string formKey, GameRelease release) =>
        EmbeddedChildLocator.Find(ownerBytes, unit.OwnerRecordType, formKey, release);
}
