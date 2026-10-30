using System.Text;
using MEditService.ModFolderAdapter;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>The Mod folder adapter's second implementation: every file held in memory, a file's hash its text, and a
/// manifest written only when it differs from the one there.</summary>
internal sealed class FakeModFolders : IModFolderRepository
{
    private readonly Dictionary<(string Folder, string Path), byte[]> _files = [];
    private readonly Dictionary<string, string> _manifests = [];
    private readonly HashSet<string> _folders = [];
    private readonly Dictionary<(string Folder, string Path), Func<Stream>> _streams = [];

    public HashSet<(string Folder, string Path)> Unreadable { get; } = [];

    public HashSet<string> UnwritableManifests { get; } = [];

    /// <summary>The mod folders whose stat cache cannot be written.</summary>
    public HashSet<string> UnwritableStatCaches { get; } = [];

    public Dictionary<string, Manifest> Manifests { get; } = [];

    /// <summary>The mod folders whose status throws, as a path the file system refuses does.</summary>
    public HashSet<string> StatusThrows { get; } = [];

    public FakeModFolders WithFile(string folder, string path, string text) => WithBytes(folder, path, Encoding.ASCII.GetBytes(text));

    public FakeModFolders WithBytes(string folder, string path, byte[] bytes)
    {
        _folders.Add(folder);
        _files[(folder, path)] = bytes;
        return this;
    }

    public FakeModFolders WithStream(string folder, string path, Func<Stream> open)
    {
        _folders.Add(folder);
        _streams[(folder, path)] = open;
        return this;
    }

    public void Without(string folder, string path) => _files.Remove((folder, path));

    public ModFolderFiles Files(string modFolder, IReadOnlySet<string> leftOut, string? statCache)
    {
        if (!_folders.Contains(modFolder)) throw new DirectoryNotFoundException(modFolder);
        var files = _files.Where(f => f.Key.Folder == modFolder && !leftOut.Contains(f.Key.Path)).ToList();
        if (files.FirstOrDefault(f => Unreadable.Contains(f.Key)) is { Key.Path: { } held }) throw new IOException($"{held} is held by another process");
        return new([.. files.Select(f => new HashedFile(f.Key.Path, Encoding.ASCII.GetString(f.Value)))]);
    }

    /// <summary>Each mod folder's hashes kept as its providers fix them, by path.</summary>
    public Dictionary<string, IReadOnlyDictionary<string, string>> KeptPackageHashes { get; } = [];

    public string? KeepInStatCache(ModFolderFiles read, Manifest manifest, IReadOnlyDictionary<string, string> provided)
    {
        var modFolder = Manifests.First(held => ReferenceEquals(held.Value, manifest)).Key;
        KeptPackageHashes[modFolder] = provided;
        return UnwritableStatCaches.Contains(modFolder) ? "stat-cache is read-only" : null;
    }

    public IReadOnlyList<string> NamedByNoLine(string modFolder, Manifest manifest, IReadOnlySet<string> leftOut)
    {
        var named = manifest.Files.Select(line => line.Path).ToHashSet(StringComparer.Ordinal);
        return [.. FilePaths(modFolder).Where(path => !named.Contains(path) && !leftOut.Contains(path))];
    }

    /// <summary>The hash a line's package fixes is the one the last keep held for its path. A source mod's manifest is the
    /// one held for its source folder.</summary>
    public ModStatus Status(string modFolder, string modName, IReadOnlySet<string> leftOut, string statCache, ModMetadata? held, string? sourceFolder)
    {
        var at = sourceFolder ?? modFolder;
        if (StatusThrows.Contains(modFolder)) throw new ArgumentException($"'{modFolder}' is not a path", nameof(modFolder));
        if (UnreadableManifests.Contains(at)) return new(modName, NoManifest: false, [], [], [], [], [], new ModUnreadable(Manifest: true, "line 1 is not a manifest line"));
        if (!Manifests.TryGetValue(at, out var manifest)) return new(modName, NoManifest: true, [], [], [], [], []);
        var kept = KeptPackageHashes.GetValueOrDefault(at) ?? new Dictionary<string, string>();
        var there = manifest.Files.ToLookup(line => _files.ContainsKey((modFolder, line.Path)));
        return new(
            modName, NoManifest: false,
            [.. there[true].Where(line => line.Entry is not (PackageEntry.NotHeld or PackageEntry.OtherBytes)
                && kept.GetValueOrDefault(line.Path) != Encoding.ASCII.GetString(_files[(modFolder, line.Path)])).Select(line => line.Path)],
            NamedByNoLine(modFolder, manifest, leftOut),
            [.. there[false].Select(line => line.Path)],
            [.. manifest.Files.Where(line => line.Entry is PackageEntry.NotHeld).Select(line => line.Path)],
            [.. manifest.Files.Where(line => line.Entry is PackageEntry.OtherBytes).Select(line => line.Path)],
            MetadataDiffers: MetadataDiffering.Contains(modFolder), ManifestMetadata: ModMetadata.Of(manifest));
    }

    public Stream OpenFile(string modFolder, string path) => Open(modFolder, path);

    public IScratchFiles CreateScratchFiles() => new ModFolderRepository(TimeProvider.System).CreateScratchFiles();

    public bool InstallationFileExists(string path) => _files.ContainsKey((string.Empty, path)) || _streams.ContainsKey((string.Empty, path));

    public string InstallationFileName(string path) => path[(path.LastIndexOf('/') + 1)..];

    public IReadOnlyList<string> FilePaths(string modFolder) =>
        [.. _files.Keys.Where(file => file.Folder == modFolder).Select(file => file.Path)];

    public bool DataFolderExists(string dataFolder) => Directory.Exists(dataFolder);

    public string ExcludedName(string name, string exclusionMark) => name + exclusionMark;

    public string FolderName(string modFolder) => modFolder[(modFolder.LastIndexOf('/') + 1)..];

    public string PathIn(string modFolder, string file) => file[(modFolder.Length + 1)..];

    public int InstallationFilesOpened { get; private set; }

    public Stream OpenInstallationFile(string path)
    {
        InstallationFilesOpened++;
        return Open(string.Empty, path);
    }

    /// <summary>A game file is a file of the folder named for the game folder.</summary>
    public Stream OpenGameFile(string root, string path) => Open(root, path);

    public Dictionary<(string Folder, string Path), byte[]> Written { get; } = [];

    public HashSet<(string Folder, string Path)> UnwritableFiles { get; } = [];

    public HashSet<string> UnreadableManifests { get; } = [];

    /// <summary>The mod folders whose status says their metadata differs from their manifest.</summary>
    public HashSet<string> MetadataDiffering { get; } = [];

    /// <summary>What reading each mod folder's manifest throws.</summary>
    public Dictionary<string, Exception> ManifestReadThrows { get; } = [];

    public Manifest? ReadManifest(string modFolder)
    {
        if (UnreadableManifests.Contains(modFolder)) throw new InvalidDataException("its manifest cannot be read at line 1");
        if (ManifestReadThrows.TryGetValue(modFolder, out var thrown)) throw thrown;
        return Manifests.GetValueOrDefault(modFolder);
    }

    public bool WriteFile(string folder, string path, Action<Stream> write)
    {
        if (UnwritableFiles.Contains((folder, path))) throw new IOException($"{path} is held by another process");
        using var content = new MemoryStream();
        write(content);
        var bytes = content.ToArray();
        Written[(folder, path)] = bytes;
        var replaced = _files.TryGetValue((folder, path), out var there) && !there.SequenceEqual(bytes);
        WithBytes(folder, path, bytes);
        return replaced;
    }

    private bool WriteManifest(string modFolder, Manifest manifest)
    {
        if (UnwritableManifests.Contains(modFolder)) throw new UnauthorizedAccessException($"{modFolder} is read-only");
        var text = string.Join('\n', manifest.Files.Select(f => f.ToString()).Prepend(manifest.Package?.ToString()));
        Manifests[modFolder] = manifest;
        if (_manifests.TryGetValue(modFolder, out var there) && there == text) return false;
        _manifests[modFolder] = text;
        return true;
    }

    public SpelledManifest? RemoveManifest(string modFolder, string sourceFolder)
    {
        if (modFolder == sourceFolder || !Manifests.Remove(modFolder)) return null;
        _manifests.Remove(modFolder, out var text);
        return new SpelledManifest($"{FolderName(modFolder)}.manifest.json", Encoding.UTF8.GetBytes(text ?? ""));
    }

    public Answer<Manifest?, string> ReadSourceManifest(string sourceFolder) =>
        UnreadableManifests.Contains(sourceFolder) ? "its manifest cannot be read at line 1" : Manifests.GetValueOrDefault(sourceFolder);

    public bool WriteSourceManifest(string sourceFolder, Manifest manifest) => WriteManifest(sourceFolder, manifest);

    public SpelledManifest SpellSourceManifest(Manifest manifest) =>
        new($"{manifest.Output}.manifest.json", Encoding.UTF8.GetBytes($"{{\"output\": \"{manifest.Output}\", \"files\": []}}"));

    private Stream Open(string folder, string path)
    {
        if (Unreadable.Contains((folder, path))) throw new IOException($"{path} is held by another process");
        return _streams.TryGetValue((folder, path), out var open) ? open() : new MemoryStream(_files[(folder, path)]);
    }
}
