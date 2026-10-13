using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is: each file comes from the first provider that holds its bytes,
/// else from a delta of the first copy at its path, else from nothing.</summary>
internal sealed class ManifestBuilder
{
    private readonly List<(string Name, InstallationFile File)> _installationFiles;
    private readonly Dictionary<string, GameFileToStage> _gameFiles = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<(string Name, ILookup<string, HashedEntry> ByHash, Dictionary<string, HashedEntry> ByPath)> _indexes;

    public ManifestBuilder(IEnumerable<(string Name, InstallationFile File)> installationFiles, IEnumerable<GameFileToStage> gameFiles)
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

    public Manifest Manifest(IReadOnlyList<ManifestFile> files) => new(
        [.. _installationFiles.Select(file => new ManifestSource(file.Name, file.File.Size, file.File.Hash, file.File.Source))],
        [
            .. files.Select(file => file.Provider switch
                {
                    FileProvider.GameFile game => game.Path,
                    FileProvider.GameFileDelta game => game.Path,
                    _ => null,
                })
                .OfType<string>()
                .Distinct(StringComparer.Ordinal)
                .Select(path => _gameFiles[path])
                .Select(game => new ManifestSource(game.Path, game.Size, game.Hash)),
        ],
        files);

    public FileProvider ProviderOf(HashedFile file)
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

        _gameFiles.TryGetValue(file.Path, out var game);
        if (game?.Hash == file.Hash) return new FileProvider.GameFile(game.Path);

        foreach (var (name, _, byPath) in _indexes)
        {
            if (byPath.TryGetValue(file.Path, out var copy)) return new FileProvider.InstallationFileDelta(name, copy.Path, copy.Hash);
        }

        return game is null ? new FileProvider.NoProvider() : new FileProvider.GameFileDelta(game.Path, game.Hash);
    }

    private static Dictionary<string, HashedEntry> IndexByPath(IReadOnlyList<HashedEntry> entries)
    {
        Dictionary<string, HashedEntry> byPath = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in entries) byPath.TryAdd(entry.Path, entry);
        return byPath;
    }
}
