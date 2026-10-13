using System.Text;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The Mod folder adapter's second implementation: every file held in memory, a file's hash its text, a
/// manifest written only when it differs from the one there, and each delta held by its key.</summary>
internal sealed class FakeModFolders : IModFolderRepository
{
    private readonly Dictionary<(string Folder, string Path), (byte[] Bytes, FileStamp? Stamp)> _files = [];
    private readonly Dictionary<string, string> _manifests = [];
    private readonly HashSet<string> _folders = [];
    private readonly Dictionary<(string Folder, string Path), Func<Stream>> _streams = [];

    public int Opens { get; private set; }

    public HashSet<(string Folder, string Path)> Unreadable { get; } = [];

    public HashSet<string> UnwritableManifests { get; } = [];

    public HashSet<string> UnwritableBuildFolders { get; } = [];

    public Dictionary<string, Manifest> Manifests { get; } = [];

    public Dictionary<(string BuildFolder, string Path, string BaseHash, string FileHash), byte[]> Deltas { get; } = [];

    public FakeModFolders WithFile(string folder, string path, string text, long modified = 0, long changed = 0) =>
        WithBytes(folder, path, Encoding.ASCII.GetBytes(text), modified, changed);

    public FakeModFolders WithBytes(string folder, string path, byte[] bytes, long modified = 0, long changed = 0)
    {
        _folders.Add(folder);
        _files[(folder, path)] = (bytes, new FileStamp(bytes.Length, modified, changed));
        return this;
    }

    public FakeModFolders WithStream(string folder, string path, Func<Stream> open)
    {
        _folders.Add(folder);
        _streams[(folder, path)] = open;
        return this;
    }

    public void Without(string folder, string path) => _files.Remove((folder, path));

    public IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut)
    {
        if (!_folders.Contains(modFolder)) throw new DirectoryNotFoundException(modFolder);
        var files = _files.Where(f => f.Key.Folder == modFolder && !leftOut.Contains(f.Key.Path)).ToList();
        if (files.FirstOrDefault(f => Unreadable.Contains(f.Key)) is { Key.Path: { } held }) throw new IOException($"{held} is held by another process");
        return [.. files.Select(f => new HashedFile(f.Key.Path, f.Value.Bytes.Length, Encoding.ASCII.GetString(f.Value.Bytes), f.Value.Stamp))];
    }

    public Stream OpenFile(string modFolder, string path) => Open(modFolder, path);

    public bool InstallationFileExists(string path) => _files.ContainsKey((string.Empty, path)) || _streams.ContainsKey((string.Empty, path));

    public string InstallationFileName(string path) => path[(path.LastIndexOf('/') + 1)..];

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        [.. _files.Keys.Where(file => file.Folder == modFolder).Select(file => file.Path)];

    public string FolderName(string modFolder) => modFolder[(modFolder.LastIndexOf('/') + 1)..];

    public string PathIn(string modFolder, string file) => file[(modFolder.Length + 1)..];

    public Stream OpenInstallationFile(string path) => Open(string.Empty, path);

    public Stream OpenGameFile(string dataFolder, string path) => Open(dataFolder, path);

    public Dictionary<(string Folder, string Path), byte[]> Written { get; } = [];

    public bool WriteFile(string folder, string path, Action<Stream> write)
    {
        using var content = new MemoryStream();
        write(content);
        var bytes = content.ToArray();
        Written[(folder, path)] = bytes;
        var replaced = _files.TryGetValue((folder, path), out var there) && !there.Bytes.SequenceEqual(bytes);
        WithBytes(folder, path, bytes);
        return replaced;
    }

    public bool WriteManifest(string modFolder, string modName, Manifest manifest)
    {
        if (UnwritableManifests.Contains(modFolder)) throw new UnauthorizedAccessException($"{modFolder} is read-only");
        var text = string.Join('\n', manifest.InstallationFiles.Select(s => s.ToString())
            .Concat(manifest.GameFiles.Select(s => s.ToString()))
            .Concat(manifest.Files.Select(f => f.ToString())));
        Manifests[modFolder] = manifest;
        if (_manifests.TryGetValue(modFolder, out var there) && there == text) return false;
        _manifests[modFolder] = text;
        return true;
    }

    public long? DeltaSize(string buildFolder, string path, string baseHash, string fileHash) =>
        Deltas.TryGetValue((buildFolder, path, baseHash, fileHash), out var delta) ? delta.Length : null;

    public bool WriteDelta(string buildFolder, string path, string baseHash, string fileHash, Func<Stream, bool> write)
    {
        if (UnwritableBuildFolders.Contains(buildFolder)) throw new UnauthorizedAccessException($"{buildFolder} is read-only");
        using var delta = new MemoryStream();
        if (!write(delta)) return false;
        Deltas[(buildFolder, path, baseHash, fileHash)] = delta.ToArray();
        return true;
    }

    public Stream CreateScratchFile(string buildFolder) => new SparseStream();

    private Stream Open(string folder, string path)
    {
        if (Unreadable.Contains((folder, path))) throw new IOException($"{path} is held by another process");
        Opens++;
        return _streams.TryGetValue((folder, path), out var open) ? open() : new MemoryStream(_files[(folder, path)].Bytes);
    }
}
