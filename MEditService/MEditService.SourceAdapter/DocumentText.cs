using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using Mutagen.Bethesda;

namespace MEditService.SourceAdapter;

/// <summary>What a document's text and bytes declare, read as text rather than through the codec. The
/// Listed readers answer null for a file that vanished since a listing named it.</summary>
internal static class DocumentText
{
    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    internal static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;

    /// <summary>The file's bytes: null when it is gone, and the file system's exception when it is there
    /// and cannot be read.</summary>
    internal static byte[]? BytesIfPresent(ISourceFiles files, string path)
    {
        try
        {
            return files.FileExists(path) ? StripUtf8Bom(files.ReadAllBytes(path)) : null;
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
    }

    /// <summary>The file's bytes: null when a listing named a file that is gone since, and a stop naming
    /// the file when it is there and cannot be read, since it still holds its keys.</summary>
    internal static byte[]? ListedBytes(ISourceFiles files, string sourceFolder, string path)
    {
        try
        {
            return BytesIfPresent(files, path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw SourceStopException.UnreadableIn(sourceFolder, path, $"it could not be read: {ex.Message}");
        }
    }

    internal static string? ListedText(ISourceFiles files, string sourceFolder, string path) =>
        ListedBytes(files, sourceFolder, path) is { } bytes ? Encoding.UTF8.GetString(bytes) : null;

    /// <summary>The FormKey the document at <paramref name="filePath"/> declares, read from
    /// <paramref name="text"/> (an embedded child's owner's, since the file is the owner's document), or
    /// null when it declares none.</summary>
    internal static string? FormKeyDeclaredIn(string text, string filePath, string pluginFileName)
    {
        // The header's document carries a ModKey rather than a FormKey; PluginHeader computes the
        // FormKey the record index files it under.
        if (SourceRepositoryLayout.IsHeaderDocumentPath(filePath, pluginFileName))
            return SourceRepositoryLayout.HeaderFormKeyOf(pluginFileName);

        return DocumentTokens.RootStringIn(text, RecordMembers.FormKey) is { } spelled ? CanonicalFormKey.Of(spelled) : null;
    }

    internal static string? UnparsedFormKeyIn(string text, string filePath, string pluginFileName) =>
        FormKeyDeclaredIn(text, filePath, pluginFileName) is null ? DocumentTokens.RootStringIn(text, RecordMembers.FormKey) : null;

    // For a text FormKeyDeclaredIn answered null for: a FormKey it holds is one Mutagen cannot parse.
    internal static string WhyNoFormKey(string text) =>
        DocumentTokens.RootStringIn(text, RecordMembers.FormKey) is { } spelled
            ? $"declares {spelled}, which is no FormKey"
            : "declares no FormKey";

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
