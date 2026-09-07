using System.Collections.Concurrent;
using System.Text.Json;
using MEditService.Core.Serialization;
using Mutagen.Bethesda;

namespace MEditService.Core.Source;

/// <summary>Which document carries a record no path names — a placed reference in its cell, a
/// response in its quest. One map per plugin's source root, from one token scan of every document
/// under it.</summary>
internal sealed class EmbeddedOwners
{
    /// <summary>The document a child sits inside: its file, and the record at its root.</summary>
    internal readonly record struct OwnerDocument(string FullPath, string FormKey, string RecordType);

    private static readonly ConcurrentDictionary<(string SourceRoot, GameRelease Release), EmbeddedOwners> Maps = new();

    private readonly string _sourceRoot;
    private readonly GameRelease _release;
    private readonly Lock _rebuilding = new();
    private volatile IReadOnlyDictionary<string, OwnerDocument> _byChild;

    private EmbeddedOwners(string sourceRoot, GameRelease release)
    {
        (_sourceRoot, _release) = (sourceRoot, release);
        _byChild = Scan(sourceRoot, release);
    }

    /// <summary>The map over <paramref name="sourceRoot"/>, shared across calls: the scan reads every
    /// document, and every answer it gives is checked against the tree before it is returned.</summary>
    internal static EmbeddedOwners For(string sourceRoot, GameRelease release)
    {
        // A root that is gone holds no documents: a compile's scratch checkout, or a mod folder MO2
        // replaced. Swept only past the limit, so the common call costs one lookup.
        if (Maps.Count > SweepAbove)
        {
            foreach (var key in Maps.Keys.Where(k => !Directory.Exists(k.SourceRoot))) Maps.TryRemove(key, out _);
        }
        return Maps.GetOrAdd((sourceRoot, release), key => new EmbeddedOwners(key.SourceRoot, key.Release));
    }

    private const int SweepAbove = 64;

    /// <summary>The document holding <paramref name="formKey"/>, or null when none does. A stale hit
    /// and a miss each read the tree again once, never a file timestamp (ADR-0001): another tool can
    /// move a child between documents.</summary>
    internal OwnerDocument? DocumentHolding(string formKey, SourceUnitResolutionCache? cache = null)
    {
        var map = _byChild;
        if (map.TryGetValue(formKey, out var owner) && StillCarries(owner.FullPath, formKey)) return owner;

        // One pass over a whole mod would otherwise read the tree again per record that moved or went.
        if (cache != null && !cache.RescannedOwnerMaps.Add(_sourceRoot))
            return map.TryGetValue(formKey, out var memoized) ? memoized : null;

        lock (_rebuilding)
        {
            _byChild = map = Scan(_sourceRoot, _release);
        }
        return map.TryGetValue(formKey, out var fresh) ? fresh : null;
    }

    private static bool StillCarries(string documentPath, string formKey) =>
        ReadOrNull(documentPath) is { } bytes
        && FormKeysIn(bytes).Any(k => k.FormKey.Equals(formKey, StringComparison.Ordinal));

    // First document wins a FormKey two of them claim: that tree is corrupt, and refusing to answer
    // at all would take every unrelated record down with it.
    private static Dictionary<string, OwnerDocument> Scan(string sourceRoot, GameRelease release)
    {
        var byChild = new Dictionary<string, OwnerDocument>(StringComparer.Ordinal);
        if (!Directory.Exists(sourceRoot)) return byChild;

        var modFolder = Path.GetDirectoryName(Path.GetDirectoryName(sourceRoot))!;
        foreach (var documentPath in Directory.EnumerateFiles(sourceRoot, "*.json", SearchOption.AllDirectories))
        {
            if (SourceDocuments.CarriesNoRecord(documentPath)) continue;
            if (ReadOrNull(documentPath) is not { } bytes) continue;

            var keys = FormKeysIn(bytes);
            if (keys.FirstOrDefault(k => k.AtRoot).FormKey is not { } root) continue;
            if (RecordTypeOf(Path.GetRelativePath(modFolder, documentPath), release) is not { } recordType) continue;

            var owner = new OwnerDocument(documentPath, root, recordType);
            foreach (var (childFormKey, atRoot) in keys)
            {
                if (!atRoot) byChild.TryAdd(childFormKey, owner);
            }
        }
        return byChild;
    }

    // The document's own top-level record type: what SourceRecordPath parses for the header and a
    // flat record, and the group folder's own for a container's directory.
    private static string? RecordTypeOf(string relativePath, GameRelease release)
    {
        if (SourceRecordPath.TryParse(relativePath, release, out var identity)) return identity.RecordType;

        // source / <plugin> / <group folder> / [block levels] / <record directory> / RecordData.json
        var segments = relativePath.Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries);
        return segments.Length >= 5
               && segments[^1].Equals(SourceUnitResolver.RecordDataFileName, StringComparison.Ordinal)
            ? RecordTypeDispatch.For(release).DirectoryPerRecordTypeIn(segments[2], nested: segments.Length > 5)
            : null;
    }

    // Never exclusive owners of the file: it may be gone or locked since the listing.
    private static byte[]? ReadOrNull(string path)
    {
        try
        {
            return File.Exists(path) ? SourceUnitResolver.StripUtf8Bom(File.ReadAllBytes(path)) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Every FormKey the document declares, each flagged with whether it is the root record's own.
    // Malformed text yields what was read before the break.
    private static List<(string FormKey, bool AtRoot)> FormKeysIn(byte[] bytes)
    {
        var found = new List<(string, bool)>();
        var reader = new Utf8JsonReader(bytes);
        var atFormKey = false;
        var depth = 0;
        try
        {
            while (reader.Read())
            {
                if (reader.TokenType == JsonTokenType.PropertyName)
                {
                    atFormKey = reader.ValueTextEquals(FormKeyPropertyName);
                    depth = reader.CurrentDepth;
                    continue;
                }
                if (atFormKey && reader.TokenType == JsonTokenType.String)
                    found.Add((reader.GetString()!, depth == 1));
                atFormKey = false;
            }
        }
        catch (JsonException)
        {
            // Caught mid-save, or hand-edited into something that is not a document.
        }
        return found;
    }

    private static ReadOnlySpan<byte> FormKeyPropertyName => "FormKey"u8;
}
