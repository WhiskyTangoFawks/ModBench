using System.Text;
using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The Mod folder adapter's second implementation: every file held in memory, and a file's hash its text.</summary>
internal sealed class FakeModFolders : IModFolderRepository
{
    private readonly Dictionary<(string Folder, string Path), byte[]> _files = [];
    private readonly Dictionary<(string Folder, string Path), Func<Stream>> _streams = [];

    public HashSet<(string Folder, string Path)> Unreadable { get; } = [];

    public FakeModFolders WithStream(string folder, string path, Func<Stream> open)
    {
        _streams[(folder, path)] = open;
        return this;
    }

    public FakeModFolders WithBytes(string folder, string path, byte[] bytes)
    {
        _files[(folder, path)] = bytes;
        return this;
    }

    public IReadOnlyDictionary<string, string> Hashes(string modFolder) =>
        _files.Where(file => file.Key.Folder == modFolder).ToDictionary(file => file.Key.Path, file => Encoding.ASCII.GetString(file.Value));

    public Stream OpenFile(string modFolder, string path)
    {
        if (Unreadable.Contains((modFolder, path))) throw new IOException($"{path} is held by another process");
        return _streams.TryGetValue((modFolder, path), out var open) ? open() : new MemoryStream(_files[(modFolder, path)]);
    }

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        [.. _files.Keys.Where(file => file.Folder == modFolder).Select(file => file.Path)];

    public bool DataFolderExists(string dataFolder) => Directory.Exists(dataFolder);

    public string ExcludedName(string name, string exclusionMark) => name + exclusionMark;

    public string PathIn(string modFolder, string file) => file[(modFolder.Length + 1)..];

    public Dictionary<(string Folder, string Path), byte[]> Written { get; } = [];

    public bool WriteFile(string folder, string path, Action<Stream> write)
    {
        using var content = new MemoryStream();
        write(content);
        var bytes = content.ToArray();
        Written[(folder, path)] = bytes;
        var replaced = _files.TryGetValue((folder, path), out var there) && !there.SequenceEqual(bytes);
        WithBytes(folder, path, bytes);
        return replaced;
    }

    public void DeleteFile(string folder, string path) => _files.Remove((folder, path));
}
