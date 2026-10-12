using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Engine;

/// <summary>A mod's manifest from the mod as it is: each file is named for the first provider that holds its
/// bytes, and a file nothing holds has no provider.</summary>
internal sealed class ManifestBuilder
{
    /// <summary>A mod folder's paths are relative to the game's Data folder.</summary>
    internal const string GameDataFolder = "Data";

    private readonly List<(string Name, string? Source, HashedInstallationFile Content)> _installationFiles;
    private readonly Func<string, HashedFile?> _gameFile;
    private readonly List<(string Name, ILookup<FileHash, HashedEntry> ByHash, Dictionary<string, HashedEntry> ByPath)> _indexes;
    private readonly Dictionary<string, ManifestSource> _gameFilesUsed = new(StringComparer.Ordinal);

    public ManifestBuilder(
        IEnumerable<(string Name, string? Source, HashedInstallationFile Content)> installationFiles,
        Func<string, HashedFile?> gameFile)
    {
        _installationFiles = [.. installationFiles];
        _gameFile = gameFile;
        _indexes =
        [
            .. _installationFiles.Select(file => (
                file.Name,
                file.Content.Entries.ToLookup(entry => entry.Hash),
                IndexByPath(file.Content.Entries))),
        ];
    }

    public Manifest Build(IReadOnlyList<HashedFile> files)
    {
        var manifestFiles = files.Select(file => new ManifestFile(file.Path, file.Hash.ToString(), file.Stamp, ProviderOf(file))).ToList();
        return new Manifest(
            [.. _installationFiles.Select(file => new ManifestSource(file.Name, file.Content.Size, file.Content.Hash.ToString(), file.Source))],
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

        var gamePath = $"{GameDataFolder}/{file.Path}";
        if (_gameFile(gamePath) is { } game && game.Hash == file.Hash)
        {
            _gameFilesUsed[gamePath] = new ManifestSource(gamePath, game.Size, game.Hash.ToString());
            return new FileProvider.GameFile(gamePath);
        }

        return new FileProvider.NoProvider();
    }
}
