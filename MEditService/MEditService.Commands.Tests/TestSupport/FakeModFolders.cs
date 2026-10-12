using System.Text;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The Mod folder adapter's second implementation: folders and installation files held in memory, a
/// file's hash its text, and a manifest written only when it differs from the one there.</summary>
internal sealed class FakeModFolders : IModFolderRepository
{
    private readonly Dictionary<(string Folder, string Path), (byte[] Bytes, FileStamp? Stamp)> _files = [];
    private readonly Dictionary<string, string> _manifests = [];
    private readonly HashSet<string> _folders = [];

    public HashSet<(string Folder, string Path)> Unreadable { get; } = [];

    public HashSet<string> UnwritableManifests { get; } = [];

    public Dictionary<string, Manifest> Manifests { get; } = [];

    public FakeModFolders WithFile(string folder, string path, string text, long modified = 0, long changed = 0) =>
        WithBytes(folder, path, Encoding.ASCII.GetBytes(text), modified, changed);

    public FakeModFolders WithBytes(string folder, string path, byte[] bytes, long modified = 0, long changed = 0)
    {
        _folders.Add(folder);
        _files[(folder, path)] = (bytes, new FileStamp(bytes.Length, modified, changed));
        return this;
    }

    public void Without(string folder, string path) => _files.Remove((folder, path));

    public IReadOnlyList<HashedFile> Files(string modFolder, string modName, IReadOnlySet<string> leftOut)
    {
        if (!_folders.Contains(modFolder)) throw new DirectoryNotFoundException(modFolder);
        var files = _files.Where(f => f.Key.Folder == modFolder && !leftOut.Contains(f.Key.Path)).ToList();
        if (files.FirstOrDefault(f => Unreadable.Contains(f.Key)) is { Key.Path: { } held }) throw new IOException($"{held} is held by another process");
        return [.. files.Select(f => new HashedFile(f.Key.Path, Encoding.ASCII.GetString(f.Value.Bytes), f.Value.Stamp))];
    }

    public StampedFile? InstallationFile(string path) =>
        _files.TryGetValue((string.Empty, path), out var file) ? new StampedFile(path, file.Stamp) : null;

    public string InstallationFileName(string path) => path[(path.LastIndexOf('/') + 1)..];

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
}
