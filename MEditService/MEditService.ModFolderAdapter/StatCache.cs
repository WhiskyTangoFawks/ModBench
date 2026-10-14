using System.Text.Json;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>What Modbench last read of one mod folder's files on this machine (modlist-source.md, Status, story 3), named
/// for the folder.</summary>
internal sealed class StatCache
{
    private sealed record Entry(long Size, long Modified, long Changed, string Hash);

    private readonly string _folder;
    private readonly string _file;
    private readonly string _modFolder;
    private readonly Dictionary<string, Entry> _read;
    private readonly StampGatedMemo<string> _memo;

    public StatCache(string folder, string modFolder, TimeProvider time)
    {
        _folder = folder;
        _modFolder = modFolder;
        _file = Path.Combine(folder, Path.GetFileName(Path.TrimEndingDirectorySeparator(modFolder)));
        _read = Read(_file);
        _memo = new StampGatedMemo<string>(time);
        foreach (var (path, entry) in _read) _memo.Remember(FileAt(path), new FileStamp(entry.Size, entry.Modified, entry.Changed), entry.Hash);
    }

    public string HashOf(string path, Func<string> read) =>
        _memo.Of(FileAt(path), read) ?? throw new InvalidOperationException("A read of a file's hash answers a hash.");

    /// <summary>Writes what this read kept of the files at <paramref name="paths"/> in place of what it found, and nothing
    /// when the two are the same. Why it could not, or null.</summary>
    public string? Write(IReadOnlyList<string> paths)
    {
        Dictionary<string, Entry> kept = new(StringComparer.Ordinal);
        foreach (var path in paths)
        {
            if (_memo.Known.TryGetValue(FileAt(path), out var known))
                kept[path] = new Entry(known.Stamp.Size, known.Stamp.Modified, known.Stamp.Changed, known.Value);
        }
        if (kept.Count == _read.Count && kept.All(entry => _read.GetValueOrDefault(entry.Key) == entry.Value)) return null;

        try
        {
            Directory.CreateDirectory(_folder);
            Replace(kept);
            return null;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return e.Message;
        }
    }

    private void Replace(Dictionary<string, Entry> kept)
    {
        var partial = Path.Combine(_folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
        try
        {
            using (var content = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(content, kept, JsonSerializerOptions.Web);
            File.Move(partial, _file, overwrite: true);
        }
        finally
        {
            File.Delete(partial);
        }
    }

    private string FileAt(string path) => Path.Combine(_modFolder, path);

    // Another read of the same mod can replace the cache while this one holds it open, and a hand can edit it.
    private static Dictionary<string, Entry> Read(string file)
    {
        try
        {
            using var content = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            Dictionary<string, Entry> read = new(StringComparer.Ordinal);
            foreach (var (path, entry) in JsonSerializer.Deserialize<Dictionary<string, Entry?>>(content, JsonSerializerOptions.Web) ?? [])
            {
                if (entry is not null) read[path] = entry;
            }
            return read;
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException or JsonException)
        {
            return new(StringComparer.Ordinal);
        }
    }
}
