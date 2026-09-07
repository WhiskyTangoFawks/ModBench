using System.Text;
using System.Text.Json;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Core.Source;

/// <summary>What the file at a path declares, read as text rather than through the codec — the
/// reverse of <see cref="SourceRepository.Locate"/>, whose question is which file a record lives
/// in.</summary>
public sealed partial class SourceRepository
{
    /// <summary>The FormKey the document at <paramref name="filePath"/> declares — an embedded child's
    /// owner's, since the file is the owner's document. Null when it cannot be read or declares
    /// none.</summary>
    public static string? FormKeyDeclaredBy(string filePath, string modFolder, string pluginFileName) =>
        DeclaredBy(filePath, modFolder, pluginFileName).FormKey;

    /// <summary>Both the members a caller identifying the document needs, from the one read: a
    /// separate call per member would read the file twice and could straddle another tool's
    /// write.</summary>
    public static (string? FormKey, string? EditorId) DeclaredBy(
        string filePath, string modFolder, string pluginFileName)
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
            return (null, null);
        }

        var text = Encoding.UTF8.GetString(StripUtf8Bom(bytes));
        return (
            FormKeyDeclaredIn(text, filePath, HeaderDocumentIn(modFolder, pluginFileName), pluginFileName),
            RootStringIn(text, "EditorID"));
    }

    /// <summary>The same answer for a caller holding the text already, so a whole-tree pass reads each
    /// file once.</summary>
    internal static string? FormKeyDeclaredIn(
        string text, string filePath, string headerDocumentPath, string pluginFileName)
    {
        // The header's document carries a ModKey rather than a FormKey; PluginHeader computes the
        // FormKey the index files it under.
        if (filePath.Equals(headerDocumentPath, StringComparison.Ordinal))
            return PluginHeader.FormKeyFor(ModKey.FromFileName(pluginFileName));

        return RootStringIn(text, "FormKey");
    }

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

    /// <summary>The record's own text out of the bytes <paramref name="unit"/>'s file holds: itself for
    /// a flat record, or re-extracted for an embedded child.</summary>
    internal static string? RecordBodyFromOwnerBytes(
        byte[]? ownerBytes, SourceUnit unit, string formKey, GameRelease release, RecordTextCodec codec)
    {
        if (ownerBytes == null) return null;

        // File.ReadAllText strips a UTF-8 BOM; raw bytes do not — unstripped, a BOM-carrying file
        // would never compare equal to the codec's BOM-free text.
        ownerBytes = StripUtf8Bom(ownerBytes);

        if (!unit.IsEmbedded) return Encoding.UTF8.GetString(ownerBytes);

        var owner = codec.DeserializeFromBytesAsync(ownerBytes, release, unit.OwnerRecordType).GetAwaiter().GetResult();
        if (ContainerChildFields.FindEmbeddedChild(owner, formKey) is not { } found) return null;

        var childBytes = codec.SerializeToBytesAsync(found.Child, release).GetAwaiter().GetResult();
        return Encoding.UTF8.GetString(childBytes);
    }

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    internal static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;
}
