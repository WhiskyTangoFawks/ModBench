using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is: the mod's one package holds each file whose bytes it has, and the
/// rest it does not hold.</summary>
internal sealed class ManifestBuilder
{
    private readonly ManifestPackage.InstallationFile? _package;
    private readonly ILookup<string, HashedEntry> _byHash;
    private readonly Dictionary<string, HashedEntry> _byPath = new(StringComparer.OrdinalIgnoreCase);

    public ManifestBuilder((string Name, InstallationFile File)? installationFile)
    {
        _package = installationFile is var (name, file) ? new ManifestPackage.InstallationFile(name, file.Size, file.Hash, file.Page) : null;
        var entries = installationFile?.File.Entries ?? [];
        _byHash = entries.ToLookup(entry => entry.Hash, StringComparer.Ordinal);
        foreach (var entry in entries) _byPath.TryAdd(entry.Path, entry);
    }

    public Manifest Manifest(IEnumerable<HashedFile> files, string? version) => new(_package, [.. files.Select(EntryOf)], version);

    private ManifestFile EntryOf(HashedFile file)
    {
        var holding = _byHash[file.Hash].ToList();
        if (_package is null || holding.Count == 0) return new ManifestFile(file.Path, new PackageEntry.NotHeld());
        var entry = _byPath.TryGetValue(file.Path, out var samePath) && samePath.Hash == file.Hash ? samePath : holding[0];
        return ManifestFile.At(file.Path, new FileBytes.InInstallationFile(_package.Name, entry.Path));
    }
}
