using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is: each file is named for the first provider that holds its
/// bytes, and a file nothing holds has no provider.</summary>
internal sealed class ManifestBuilder
{
    private readonly List<(string Name, InstallationFileToStage File)> _installationFiles;
    private readonly Dictionary<string, GameFileToStage> _gameFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<(string Name, ILookup<string, HashedEntry> ByHash, Dictionary<string, HashedEntry> ByPath)> _indexes;
    private readonly Dictionary<string, ManifestSource> _gameFilesUsed = new(StringComparer.Ordinal);

    public ManifestBuilder(IEnumerable<(string Name, InstallationFileToStage File)> installationFiles, IEnumerable<GameFileToStage> gameFiles)
    {
        _installationFiles = [.. installationFiles];
        foreach (var gameFile in gameFiles) _gameFiles.TryAdd(gameFile.Path, gameFile);
        _indexes =
        [
            .. _installationFiles.Select(file => (
                file.Name,
                file.File.Entries.ToLookup(entry => entry.Hash, StringComparer.Ordinal),
                IndexByPath(file.File.Entries))),
        ];
    }

    public Manifest Build(IReadOnlyList<HashedFile> files)
    {
        var manifestFiles = files.Select(file => new ManifestFile(file.Path, file.Hash, file.Stamp, ProviderOf(file))).ToList();
        return new Manifest(
            [.. _installationFiles.Select(file => new ManifestSource(file.Name, file.File.Size, file.File.Hash, file.File.Source))],
            [.. _gameFilesUsed.Values],
            manifestFiles);
    }

    private static Dictionary<string, HashedEntry> IndexByPath(IReadOnlyList<HashedEntry> entries)
    {
        Dictionary<string, HashedEntry> byPath = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries) byPath.TryAdd(entry.Path, entry);
        return byPath;
    }

    private FileProvider ProviderOf(HashedFile file)
    {
        if (_indexes.Count > 0 && _indexes[0].ByPath.TryGetValue(file.Path, out var sameFirst) && sameFirst.Hash == file.Hash)
            return new FileProvider.FirstInstallationFile();

        foreach (var (name, byHash, byPath) in _indexes)
        {
            var holding = byHash[file.Hash].ToList();
            if (holding.Count == 0) continue;
            var entry = byPath.TryGetValue(file.Path, out var samePath) && samePath.Hash == file.Hash ? samePath : holding[0];
            return new FileProvider.InstallationFileEntry(name, entry.Path);
        }

        if (_gameFiles.TryGetValue(file.Path, out var game) && game.Hash == file.Hash)
        {
            _gameFilesUsed[game.Path] = new ManifestSource(game.Path, game.Size, game.Hash);
            return new FileProvider.GameFile(game.Path);
        }

        return new FileProvider.NoProvider();
    }
}
