using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is: its one package holds each file whose bytes it has. With no installation
/// file, the package is the game folder when it holds each file with its bytes.</summary>
internal sealed class ManifestBuilder
{
    private readonly ManifestPackage.InstallationFile? _package;
    private readonly GameFolder? _gameFolder;
    private readonly ILookup<string, HashedEntry> _byHash;
    private readonly Dictionary<string, HashedEntry> _byPath = new(StringComparer.OrdinalIgnoreCase);

    public ManifestBuilder((string Name, InstallationFile File)? installationFile, GameFolder? gameFolder)
    {
        _gameFolder = gameFolder;
        _package = installationFile is var (name, file) ? new ManifestPackage.InstallationFile(name, file.Size, file.Hash, file.Page) : null;
        var entries = installationFile?.File.Entries ?? [];
        _byHash = entries.ToLookup(entry => entry.Hash, StringComparer.Ordinal);
        foreach (var entry in entries) _byPath.TryAdd(entry.Path, entry);
    }

    /// <summary>What <paramref name="held"/> says that no folder shows, its steps and the files they make, kept as written
    /// (ADR-0022).</summary>
    public Manifest Manifest(IReadOnlyList<HashedFile> files, string? version, Manifest? held)
    {
        var madeByStep = held?.Files.Where(line => line.Entry is PackageEntry.MadeByStep).Select(line => line.Path).ToHashSet(StringComparer.Ordinal) ?? [];
        var recorded = Recorded([.. files.Where(file => !madeByStep.Contains(file.Path))], version);
        return (held ?? recorded) with
        {
            Packages = recorded.Packages,
            Version = recorded.Version,
            Files = [.. recorded.Files, .. madeByStep.Select(path => new ManifestFile(path, new PackageEntry.MadeByStep()))],
        };
    }

    // The version rides the package line, so a mod with no package has none.
    private Manifest Recorded(IReadOnlyList<HashedFile> files, string? version)
    {
        if (FromGameFolder(files) is { } gameFolder)
            return new(gameFolder, [.. files.Select(file => new ManifestFile(file.Path, new PackageEntry.Held()))], version);
        if (_package is null) return new([], [.. files.Select(EntryOf)]);
        return new(_package, [.. files.Select(EntryOf)], version);
    }

    private ManifestPackage.GameFolder? FromGameFolder(IReadOnlyList<HashedFile> files)
    {
        if (_package is not null || _gameFolder is null || files.Count == 0) return null;
        var hashes = _gameFolder.Files.ToLookup(file => file.Path, file => file.Hash, StringComparer.OrdinalIgnoreCase);
        return files.All(file => hashes[file.Path].Contains(file.Hash))
            ? new ManifestPackage.GameFolder(_gameFolder.Name, FileHash.OfFilesTaken(files))
            : null;
    }

    private ManifestFile EntryOf(HashedFile file)
    {
        var holding = _byHash[file.Hash].ToList();
        if (_package is null) return new ManifestFile(file.Path, new PackageEntry.NotHeld());
        if (holding.Count == 0)
            return new ManifestFile(file.Path, _byPath.ContainsKey(file.Path) ? new PackageEntry.OtherBytes() : new PackageEntry.NotHeld());
        var entry = _byPath.TryGetValue(file.Path, out var samePath) && samePath.Hash == file.Hash ? samePath : holding[0];
        return ManifestFile.At(file.Path, new FileBytes.InInstallationFile(_package.Name, entry.Path));
    }
}
