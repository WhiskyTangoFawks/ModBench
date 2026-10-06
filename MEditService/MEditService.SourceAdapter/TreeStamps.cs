using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>A file of a plugin's tree, as the mod folder spells it, that could not be read as a
/// document, and the FormKey it was read for when one is known.</summary>
public sealed record UnreadableFile(string SourceRelativePath, string Message, string? FormKey = null);

/// <summary>A FormKey that more than one document of a plugin's tree declares, with those documents
/// as the mod folder spells them.</summary>
public sealed record ClaimedFormKey(string FormKey, IReadOnlyList<string> Documents)
{
    public string Message =>
        $"More than one document in this plugin's source tree holds {FormKey}: " +
        $"{string.Join(", ", Documents.Select(d => $"'{d}'"))}. A FormKey is unique within a plugin, so the tree " +
        "is corrupt — most likely a copy or an interrupted rename. Remove the duplicate by hand.";

    public bool Equals(ClaimedFormKey? other) =>
        other is not null && FormKey == other.FormKey && Documents.SequenceEqual(other.Documents);

    public override int GetHashCode() => FormKey.GetHashCode(StringComparison.Ordinal);
}

/// <summary>Every document of a plugin's tree by the FormKey it declares, each with its content stamp,
/// each file that could not be read as one, and each FormKey more than one document declares.</summary>
public sealed record RecordStamps(
    IReadOnlyDictionary<string, string> ByFormKey, IReadOnlyList<UnreadableFile> Unreadable,
    IReadOnlyList<ClaimedFormKey> Claimed)
{
    /// <summary>Equal when the same documents carry the same stamps, and the same files could not be
    /// read or claim one FormKey.</summary>
    public bool Equals(RecordStamps? other) =>
        other is not null
        && ByFormKey.Count == other.ByFormKey.Count
        && ByFormKey.All(stamp => other.ByFormKey.TryGetValue(stamp.Key, out var theirs) && theirs == stamp.Value)
        && Unreadable.SequenceEqual(other.Unreadable)
        && Claimed.SequenceEqual(other.Claimed);

    public override int GetHashCode() => ByFormKey.Count;
}

/// <summary>A record's content stamp: what the index remembers of a document, and what the tree is
/// asked against (ADR-0003).</summary>
internal static class TreeStamps
{
    // A file system stamps a change with a clock coarser than a hash is quick, and a network share's
    // clock is not this machine's: a stamp this recent may not change for a write that follows it.
    private static readonly TimeSpan SettledAfter = TimeSpan.FromSeconds(2);

    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, KnownDocument>> Known =
        new(StringComparer.Ordinal);

    private readonly record struct KnownDocument(FileStamp Stamp, string FormKey, string Content);

    internal static string ContentStamp(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    internal static RecordStamps StampsOf(string modFolder, PluginAddress plugin)
    {
        var unreadable = new List<UnreadableFile>();
        var holders = new OneDocumentPerFormKey(modFolder);
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);

        var root = SourceRepositoryLayout.RootIn(modFolder, plugin.Name);
        foreach (var gone in Known.Keys.Where(tree => !Directory.Exists(tree))) Known.TryRemove(gone, out _);
        var known = Known.GetOrAdd(root, _ => new ConcurrentDictionary<string, KnownDocument>(StringComparer.Ordinal));
        var listed = new HashSet<string>(StringComparer.Ordinal);
        if (Directory.Exists(root))
        {
            // Keyed by the FormKey the document declares, never by its path: a file name carries an
            // EditorID that may contain the separator, so a path is not a decidable identity.
            foreach (var file in Directory.EnumerateFiles(root, $"*{SourceRepositoryLayout.JsonSuffix}", SearchOption.AllDirectories))
            {
                if (SourceRepositoryLayout.CarriesNoRecord(file)) continue;
                listed.Add(file);

                var relativePath = Path.GetRelativePath(modFolder, file);
                if (KnownOrRead(known, file, relativePath, plugin.Name, unreadable) is not { } document) continue;
                holders.Hold(document.FormKey, file);
                stamps[document.FormKey] = document.Content;
            }
        }

        foreach (var path in known.Keys.Where(path => !listed.Contains(path))) known.TryRemove(path, out _);
        return new RecordStamps(stamps, unreadable, holders.Claimed);
    }

    private static KnownDocument? KnownOrRead(
        ConcurrentDictionary<string, KnownDocument> known, string file, string relativePath, string pluginName,
        List<UnreadableFile> unreadable)
    {
        var current = FileStamp.Of(file);
        if (current is { } now && known.TryGetValue(file, out var remembered) && remembered.Stamp == now) return remembered;

        var readFrom = TimeProvider.System.GetUtcNow();
        byte[] bytes;
        try
        {
            bytes = DocumentText.StripUtf8Bom(File.ReadAllBytes(file));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Never exclusive owners of a file: it may vanish or lock between the listing and the
            // read. A skip and a line, and the tree stops counting as evidence a record is gone.
            known.TryRemove(file, out _);
            unreadable.Add(new UnreadableFile(relativePath, $"Could not read '{relativePath}': {ex.Message}"));
            return null;
        }

        var text = Encoding.UTF8.GetString(bytes);
        if (DocumentText.FormKeyDeclaredIn(text, file, pluginName) is not { } formKey)
        {
            known.TryRemove(file, out _);
            unreadable.Add(new UnreadableFile(
                relativePath,
                DocumentText.JsonErrorIn(text) is { } error
                    ? $"'{relativePath}' is not valid JSON: {error}"
                    : $"'{relativePath}' declares no FormKey, so the records it holds could not be validated."));
            return null;
        }

        var read = new KnownDocument(current ?? default, formKey, ContentStamp(text));
        if (current is { } before && before.ChangedBefore(readFrom - SettledAfter)) known[file] = read;
        else known.TryRemove(file, out _);
        return read;
    }
}
