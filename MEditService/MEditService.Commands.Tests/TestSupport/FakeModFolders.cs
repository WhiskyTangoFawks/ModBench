using System.Text;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The Mod folder adapter's second implementation: folders, installation files and a game folder held in
/// memory, a manifest written only when it differs from the one there.</summary>
internal sealed class FakeModFolders : IModFolderRepository
{
    private readonly Dictionary<(string Folder, string Path), (byte[] Bytes, FileStamp? Stamp)> _files = [];
    private readonly Dictionary<string, string> _manifests = [];
    private readonly HashSet<string> _folders = [];

    public int Opens { get; private set; }

    public HashSet<(string Folder, string Path)> Unreadable { get; } = [];

    public HashSet<string> UnwritableManifests { get; } = [];

    public Dictionary<string, Manifest> Manifests { get; } = [];

    public FakeModFolders WithFolder(string folder)
    {
        _folders.Add(folder);
        return this;
    }

    public FakeModFolders WithFile(string folder, string path, string text, long modified = 0, long changed = 0) =>
        WithBytes(folder, path, Encoding.ASCII.GetBytes(text), modified, changed);

    public FakeModFolders WithBytes(string folder, string path, byte[] bytes, long modified = 0, long changed = 0)
    {
        _folders.Add(folder);
        _files[(folder, path)] = (bytes, new FileStamp(bytes.Length, modified, changed));
        return this;
    }

    public void Without(string folder, string path) => _files.Remove((folder, path));

    public FakeModFolders WithUnstampedFile(string folder, string path, string text)
    {
        _folders.Add(folder);
        _files[(folder, path)] = (Encoding.ASCII.GetBytes(text), null);
        return this;
    }

    public IReadOnlyList<StampedFile> Files(string modFolder, string modName)
    {
        if (!_folders.Contains(modFolder)) throw new DirectoryNotFoundException(modFolder);
        return [.. _files.Where(f => f.Key.Folder == modFolder).Select(f => new StampedFile(f.Key.Path, f.Value.Stamp))];
    }

    public StampedFile? InstallationFile(string path) => Described(string.Empty, path);

    public StampedFile? GameFile(string gameFolder, string path) => Described(gameFolder, path);

    public string InstallationFileName(string path) => path[(path.LastIndexOf('/') + 1)..];

    public Stream OpenFile(string folder, string path) => Open(folder, path);

    public Stream OpenInstallationFile(string path) => Open(string.Empty, path);

    public Dictionary<(string Folder, string Path), byte[]> Written { get; } = [];

    public void WriteFile(string folder, string path, Action<Stream> write)
    {
        using var content = new MemoryStream();
        write(content);
        Written[(folder, path)] = content.ToArray();
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

    private StampedFile? Described(string folder, string path) =>
        _files.TryGetValue((folder, path), out var file) ? new StampedFile(path, file.Stamp) : null;

    private MemoryStream Open(string folder, string path)
    {
        if (Unreadable.Contains((folder, path))) throw new IOException($"{path} is held by another process");
        Opens++;
        return new MemoryStream(_files[(folder, path)].Bytes);
    }
}
