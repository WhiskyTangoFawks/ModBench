using System.Text;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.SourceAdapter;

/// <summary>What the file at a path declares, read as text rather than through the codec — the
/// reverse of <see cref="SourceRepository.Locate"/>, whose question is which file a record lives
/// in.</summary>
public sealed partial class SourceRepository
{
    /// <summary>The container document of <paramref name="identity"/>: its own when it has a file of
    /// its own, else the document of the container it is embedded in — a container may itself be
    /// embedded.</summary>
    public SourceDocument? ContainerDocument(
        PluginCopyKey plugin, RecordIdentity identity, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        if (Locate(plugin, identity) is not { } unit || !File.Exists(unit.FullPath)) return null;
        var text = Encoding.UTF8.GetString(StripUtf8Bom(File.ReadAllBytes(unit.FullPath)));

        if (!unit.IsEmbedded)
            return new SourceDocument(identity.FormKey, identity.RecordType, identity.EditorId, text);

        var owner = IdentityOf(plugin, unit.OwnerFormKey, schemas)
            ?? throw new InvalidOperationException(
                $"{unit.RelativePath} carries {identity.FormKey}, but {unit.OwnerFormKey} names no " +
                "document of its own.");
        return new SourceDocument(owner.FormKey, owner.RecordType, owner.EditorId, text);
    }

    /// <summary>The FormKey the document at <paramref name="filePath"/> declares — an embedded child's
    /// owner's, since the file is the owner's document. Null when it cannot be read or declares
    /// none.</summary>
    public static string? FormKeyDeclaredBy(string filePath, string pluginFileName)
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

        return FormKeyDeclaredIn(Encoding.UTF8.GetString(StripUtf8Bom(bytes)), filePath, pluginFileName);
    }

    /// <summary>The FormKey HEAD's document at <paramref name="filePath"/> declares, whatever the working
    /// tree holds there now. Null when HEAD holds no document there or it declares none.</summary>
    public static string? FormKeyCommittedAt(string modFolder, string filePath, string pluginFileName) =>
        ReadCommittedSourceText(modFolder, Path.GetRelativePath(modFolder, filePath)) is { } committed
            ? FormKeyDeclaredIn(committed, filePath, pluginFileName)
            : null;

    /// <summary>Every document in the working tree by the FormKey it declares. An unreadable file is a
    /// failure line and clears <paramref name="fullyRead"/>; a FormKey two documents declare throws
    /// <see cref="AmbiguousSourceUnitException"/>.</summary>
    public static Dictionary<string, string> DocumentsByDeclaredFormKey(
        string modFolder, string pluginFileName, List<string> failures, out bool fullyRead)
    {
        fullyRead = true;
        var filedAt = new Dictionary<string, string>(StringComparer.Ordinal);
        var documents = new Dictionary<string, string>(StringComparer.Ordinal);

        // Keyed by the FormKey the document declares, never by its path: a file name carries an
        // EditorID that may contain the separator, so a path is not a decidable identity.
        foreach (var file in Directory.EnumerateFiles(RootIn(modFolder, pluginFileName), $"*{JsonSuffix}", SearchOption.AllDirectories))
        {
            if (CarriesNoRecord(file)) continue;

            string text;
            try
            {
                text = Encoding.UTF8.GetString(StripUtf8Bom(File.ReadAllBytes(file)));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // Never exclusive owners of a file: it may vanish or lock between the listing and the
                // read. A skip and a line, and the tree stops counting as evidence a record is gone.
                failures.Add($"Could not read '{file}': {ex.Message}");
                fullyRead = false;
                continue;
            }

            if (FormKeyDeclaredIn(text, file, pluginFileName) is not { } formKey)
            {
                failures.Add($"'{file}' declares no FormKey, so the records it holds could not be validated.");
                fullyRead = false;
                continue;
            }

            OneDocumentPerFormKey.Claim(filedAt, formKey, file, modFolder);
            documents[formKey] = text;
        }

        return documents;
    }

    /// <summary>The same answer for a caller holding the text already, so a whole-tree pass reads each
    /// file once.</summary>
    public static string? FormKeyDeclaredIn(string text, string filePath, string pluginFileName) =>
        // The header's document carries a ModKey rather than a FormKey; PluginHeader computes the
        // FormKey the index files it under.
        IsHeaderDocumentPath(filePath, pluginFileName)
            ? HeaderFormKeyOf(pluginFileName)
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
            ? EmbeddedChildSplice.Extract(ownerBytes, span, release)
            : null;
    }

    /// <summary>Where the owner's text carries the child, with the owner's own type taken from the
    /// record type its path decides — the one fact the text alone cannot supply.</summary>
    internal static EmbeddedChildSpan? EmbeddedChildIn(
        byte[] ownerBytes, SourceUnit unit, string formKey, GameRelease release) =>
        EmbeddedChildSplice.Find(
            ownerBytes, EmbeddedChildSplice.ContainerTypeName(unit.OwnerRecordType, ownerBytes, release), formKey, release);

    private static readonly byte[] Utf8Bom = [0xEF, 0xBB, 0xBF];

    public static byte[] StripUtf8Bom(byte[] bytes) =>
        bytes.AsSpan(0, Math.Min(bytes.Length, Utf8Bom.Length)).SequenceEqual(Utf8Bom) ? bytes[Utf8Bom.Length..] : bytes;
}
