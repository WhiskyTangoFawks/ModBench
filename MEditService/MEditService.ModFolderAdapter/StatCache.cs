using System.IO.Hashing;
using System.Text;
using System.Text.Json;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>What Modbench last read of one mod folder's files on this machine (modlist-repository.md, Status, story 3), and
/// the hash its package fixes for each file, as the last build was handed it.</summary>
internal sealed class StatCache
{
    private sealed record Entry(long Size, long Modified, long Changed, string Hash);

    private sealed record PackageHash(string Package, string Path, string Hash);

    private sealed record Content(Dictionary<string, Entry?>? Files, List<PackageHash?>? Packages);

    private readonly string _folder;
    private readonly string _file;
    private readonly string _modFolder;
    private readonly Dictionary<string, Entry> _read;
    private readonly Dictionary<(string Package, string Path), string> _fixes;
    private readonly StampGatedMemo<string> _memo;

    public StatCache(string folder, string modFolder, TimeProvider time)
    {
        _folder = folder;
        _modFolder = modFolder;
        _file = Path.Combine(folder, FileNameFor(modFolder));
        _memo = new StampGatedMemo<string>(time);
        (_read, _fixes) = Parsed(Read(_file));
        foreach (var (path, entry) in _read) _memo.Remember(FileAt(path), new FileStamp(entry.Size, entry.Modified, entry.Changed), entry.Hash);
    }

    // Two folders of one name, a mod's and one outside the mod folders, never share a file: it is named for the whole path.
    private static string FileNameFor(string modFolder) =>
        Convert.ToHexString(XxHash64.Hash(Encoding.UTF8.GetBytes(Path.GetFullPath(Path.TrimEndingDirectorySeparator(modFolder)))));

    private static (Dictionary<string, Entry> Files, Dictionary<(string Package, string Path), string> Fixes) Parsed(Content content)
    {
        Dictionary<string, Entry> files = new(StringComparer.Ordinal);
        foreach (var (path, entry) in content.Files ?? [])
        {
            if (entry is not null) files[path] = entry;
        }
        Dictionary<(string Package, string Path), string> fixes = [];
        foreach (var fix in (content.Packages ?? []).OfType<PackageHash>()) fixes[(fix.Package, fix.Path)] = fix.Hash;
        return (files, fixes);
    }

    public string HashOf(string path, Func<string> read) =>
        _memo.Of(FileAt(path), read) ?? throw new InvalidOperationException("A read of a file's hash answers a hash.");

    // Each write replaces the whole cache.
    private static readonly Lock Writing = new();

    /// <summary>Writes what this read kept of the files at <paramref name="paths"/>, and <paramref name="fixes"/>, in
    /// place of what it found, and nothing when the two are the same. Why it could not, or null.</summary>
    public string? Write(IReadOnlyList<string> paths, IReadOnlyDictionary<(string Package, string Path), string> fixes)
    {
        lock (Writing) return Write(Kept(paths), _read, fixes, _fixes);
    }

    private Dictionary<string, Entry> Kept(IReadOnlyList<string> paths)
    {
        Dictionary<string, Entry> kept = new(StringComparer.Ordinal);
        foreach (var path in paths)
        {
            if (_memo.Known.TryGetValue(FileAt(path), out var known))
                kept[path] = new Entry(known.Stamp.Size, known.Stamp.Modified, known.Stamp.Changed, known.Value);
        }
        return kept;
    }

    private string? Write(
        Dictionary<string, Entry> kept, Dictionary<string, Entry> found,
        IReadOnlyDictionary<(string Package, string Path), string> fixes, Dictionary<(string Package, string Path), string> foundFixes)
    {
        if (Same(kept, found) && Same(fixes, foundFixes)) return null;

        try
        {
            Directory.CreateDirectory(_folder);
            Replace(new Content(
                kept.ToDictionary(entry => entry.Key, Entry? (entry) => entry.Value, StringComparer.Ordinal),
                [.. fixes.Select(fix => new PackageHash(fix.Key.Package, fix.Key.Path, fix.Value))]));
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return e.Message;
        }
    }

    private static bool Same<TKey, TValue>(IReadOnlyDictionary<TKey, TValue> one, IReadOnlyDictionary<TKey, TValue> other) =>
        one.Count == other.Count && one.All(entry => other.TryGetValue(entry.Key, out var value) && Equals(value, entry.Value));

    private void Replace(Content content)
    {
        var partial = TempName.FileIn(_folder);
        try
        {
            using (var stream = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(stream, content, JsonSerializerOptions.Web);
            File.Move(partial, _file, overwrite: true);
        }
        finally
        {
            File.Delete(partial);
        }
    }

    private string FileAt(string path) => Path.Combine(_modFolder, path);

    // Another read of the same mod can replace the cache while this one holds it open, and a hand can edit it.
    private static Content Read(string file)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return JsonSerializer.Deserialize<Content>(stream, JsonSerializerOptions.Web) ?? new Content(null, null);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException or JsonException)
        {
            return new Content(null, null);
        }
    }
}
