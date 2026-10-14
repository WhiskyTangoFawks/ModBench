using System.Text.Json;
using MEditService.RepositoriesLib;

namespace MEditService.ModFolderAdapter;

/// <summary>Each file's hash as Modbench last read it on this machine, trusted while its size, modified time and change
/// time hold: a tool can keep a modified time, and every write moves the change time (ADR-0003).</summary>
internal sealed class StatCache
{
    private sealed record Entry(long Size, long Modified, long Changed, string Hash)
    {
        public FileStamp Stamp => new(Size, Modified, Changed);
    }

    private readonly string _folder;
    private readonly string _file;
    private readonly Dictionary<string, Entry> _read;
    private readonly Dictionary<string, Entry> _kept = new(StringComparer.Ordinal);

    public StatCache(string folder, string modName)
    {
        _folder = folder;
        _file = Path.Combine(folder, modName + ".json");
        _read = Read(_file);
    }

    /// <summary>The hash last read of the file at <paramref name="path"/> while its stamp is unchanged, else
    /// <paramref name="read"/>'s, kept once the stamp is old enough that a later write would move it.</summary>
    public string HashOf(string path, FileStamp? stamp, DateTimeOffset readFrom, Func<string> read)
    {
        if (stamp is { } now && _read.TryGetValue(path, out var known) && known.Stamp == now)
        {
            _kept[path] = known;
            return known.Hash;
        }

        var hash = read();
        if (stamp is { } before && before.SettledAt(readFrom)) _kept[path] = new Entry(before.Size, before.Modified, before.Changed, hash);
        return hash;
    }

    /// <summary>Writes what this read kept in place of what it found, and nothing when the two are the same.</summary>
    public void Write()
    {
        if (_kept.Count == _read.Count && _kept.All(entry => _read.GetValueOrDefault(entry.Key) == entry.Value)) return;

        Directory.CreateDirectory(_folder);
        var partial = Path.Combine(_folder, ".medit_tmp_" + Path.GetRandomFileName() + ".tmp");
        try
        {
            using (var content = new FileStream(partial, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                JsonSerializer.Serialize(content, _kept, JsonSerializerOptions.Web);
            File.Move(partial, _file, overwrite: true);
        }
        finally
        {
            File.Delete(partial);
        }
    }

    // Another read of the same mod can replace the cache while this one holds it open.
    private static Dictionary<string, Entry> Read(string file)
    {
        try
        {
            using var content = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return new(JsonSerializer.Deserialize<Dictionary<string, Entry>>(content, JsonSerializerOptions.Web) ?? [], StringComparer.Ordinal);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException or JsonException)
        {
            return new(StringComparer.Ordinal);
        }
    }
}
