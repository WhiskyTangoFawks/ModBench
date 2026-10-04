using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using MEditService.LoadOrder;
using MEditService.RepositoriesLib;

namespace MEditService.SourceAdapter;

/// <summary>Every document of a plugin's tree by the FormKey it declares, each with its content stamp,
/// and a line for each file that could not be read as one.</summary>
public sealed record RecordStamps(IReadOnlyDictionary<string, string> ByFormKey, IReadOnlyList<string> Unreadable)
{
    /// <summary>Equal when the same documents carry the same stamps and the same files could not be read.</summary>
    public bool Equals(RecordStamps? other) =>
        other is not null
        && ByFormKey.Count == other.ByFormKey.Count
        && ByFormKey.All(stamp => other.ByFormKey.TryGetValue(stamp.Key, out var theirs) && theirs == stamp.Value)
        && Unreadable.SequenceEqual(other.Unreadable);

    public override int GetHashCode() => ByFormKey.Count;
}

/// <summary>A record's content stamp: what the index remembers of a document, and what the tree is
/// asked against (ADR-0003).</summary>
public sealed partial class SourceRepository
{
    // A file system stamps a change with a clock coarser than a hash is quick, and a network share's
    // clock is not this machine's: a stamp this recent may not change for a write that follows it.
    private static readonly TimeSpan SettledAfter = TimeSpan.FromSeconds(2);

    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<string, KnownDocument>> Known =
        new(StringComparer.Ordinal);

    private readonly record struct KnownDocument(FileStamp Stamp, string FormKey, string Content);

    /// <summary>The stamp of one document's text, as the UTF-8 the index stores it in: every side hashes
    /// through here, so a file that is not valid UTF-8 stamps alike on disk and in the index.</summary>
    public static string ContentStamp(string text) => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(text)));

    /// <summary>One listing of the plugin's tree. A file whose file-system stamp is unchanged and
    /// settled is not read again. A FormKey two documents declare throws
    /// <see cref="AmbiguousSourceUnitException"/>.</summary>
    public RecordStamps StampsOf(PluginAddress plugin)
    {
        var unreadable = new List<string>();
        var filedAt = new Dictionary<string, string>(StringComparer.Ordinal);
        var stamps = new Dictionary<string, string>(StringComparer.Ordinal);

        var root = RootIn(_modFolder, plugin.Name);
        foreach (var gone in Known.Keys.Where(tree => !Directory.Exists(tree))) Known.TryRemove(gone, out _);
        var known = Known.GetOrAdd(root, _ => new ConcurrentDictionary<string, KnownDocument>(StringComparer.Ordinal));
        var listed = new HashSet<string>(StringComparer.Ordinal);
        if (Directory.Exists(root))
        {
            // Keyed by the FormKey the document declares, never by its path: a file name carries an
            // EditorID that may contain the separator, so a path is not a decidable identity.
            foreach (var file in Directory.EnumerateFiles(root, $"*{JsonSuffix}", SearchOption.AllDirectories))
            {
                if (CarriesNoRecord(file)) continue;
                listed.Add(file);

                if (KnownOrRead(known, file, plugin.Name, unreadable) is not { } document) continue;
                OneDocumentPerFormKey.Claim(filedAt, document.FormKey, file, _modFolder);
                stamps[document.FormKey] = document.Content;
            }
        }

        foreach (var path in known.Keys.Where(path => !listed.Contains(path))) known.TryRemove(path, out _);
        return new RecordStamps(stamps, unreadable);
    }

    private static KnownDocument? KnownOrRead(
        ConcurrentDictionary<string, KnownDocument> known, string file, string pluginName, List<string> unreadable)
    {
        var current = FileStamp.Of(file);
        if (current is { } now && known.TryGetValue(file, out var remembered) && remembered.Stamp == now) return remembered;

        var readFrom = TimeProvider.System.GetUtcNow();
        byte[] bytes;
        try
        {
            bytes = StripUtf8Bom(File.ReadAllBytes(file));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Never exclusive owners of a file: it may vanish or lock between the listing and the
            // read. A skip and a line, and the tree stops counting as evidence a record is gone.
            known.TryRemove(file, out _);
            unreadable.Add($"Could not read '{file}': {ex.Message}");
            return null;
        }

        var text = Encoding.UTF8.GetString(bytes);
        if (FormKeyDeclaredIn(text, file, pluginName) is not { } formKey)
        {
            known.TryRemove(file, out _);
            unreadable.Add($"'{file}' declares no FormKey, so the records it holds could not be validated.");
            return null;
        }

        var read = new KnownDocument(current ?? default, formKey, ContentStamp(text));
        if (current is { } before && before.ChangedBefore(readFrom - SettledAfter)) known[file] = read;
        else known.TryRemove(file, out _);
        return read;
    }
}
