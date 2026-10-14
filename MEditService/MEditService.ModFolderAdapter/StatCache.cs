using System.Text.Json;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>What Modbench last read of one mod folder's files on this machine (modlist-source.md, Status, story 3), and
/// the hash each provider of its manifest fixes as the last update or restore was handed it.</summary>
internal sealed class StatCache
{
    private sealed record Entry(long Size, long Modified, long Changed, string Hash);

    private sealed record ProviderHash(string Source, string Path, string Hash);

    private sealed record Content(Dictionary<string, Entry?>? Files, List<ProviderHash?>? Providers);

    private readonly string _folder;
    private readonly string _file;
    private readonly string _modFolder;
    private readonly Dictionary<string, Entry> _read = new(StringComparer.Ordinal);
    private readonly Dictionary<(string Source, string Path), string> _providers = [];
    private readonly StampGatedMemo<string> _memo;

    public StatCache(string folder, string modFolder, TimeProvider time)
    {
        _folder = folder;
        _modFolder = modFolder;
        _file = Path.Combine(folder, Path.GetFileName(Path.TrimEndingDirectorySeparator(modFolder)));
        _memo = new StampGatedMemo<string>(time);
        var content = Read(_file);
        foreach (var (path, entry) in content.Files ?? [])
        {
            if (entry is null) continue;
            _read[path] = entry;
            _memo.Remember(FileAt(path), new FileStamp(entry.Size, entry.Modified, entry.Changed), entry.Hash);
        }
        foreach (var provider in (content.Providers ?? []).OfType<ProviderHash>()) _providers[(provider.Source, provider.Path)] = provider.Hash;
    }

    public string HashOf(string path, Func<string> read) =>
        _memo.Of(FileAt(path), read) ?? throw new InvalidOperationException("A read of a file's hash answers a hash.");

    public string? HashFixedBy((string Source, string Path) provider) => _providers.GetValueOrDefault(provider);

    /// <summary>Writes what this read kept of the files at <paramref name="paths"/>, and <paramref name="providers"/>, in
    /// place of what it found, and nothing when the two are the same. Why it could not, or null.</summary>
    public string? Write(IReadOnlyList<string> paths, IReadOnlyDictionary<(string Source, string Path), string> providers)
    {
        Dictionary<string, Entry> kept = new(StringComparer.Ordinal);
        foreach (var path in paths)
        {
            if (_memo.Known.TryGetValue(FileAt(path), out var known))
                kept[path] = new Entry(known.Stamp.Size, known.Stamp.Modified, known.Stamp.Changed, known.Value);
        }
        if (Same(kept, _read) && Same(providers, _providers)) return null;

        try
        {
            Directory.CreateDirectory(_folder);
            Replace(new Content(
                kept.ToDictionary(entry => entry.Key, Entry? (entry) => entry.Value, StringComparer.Ordinal),
                [.. providers.Select(provider => new ProviderHash(provider.Key.Source, provider.Key.Path, provider.Value))]));
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
        var partial = Path.Combine(_folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
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
