using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is. Each file is taken by its hash from the mod's installation file, then the
/// game folder, then another downloaded file.</summary>
internal sealed class ManifestBuilder
{
    private readonly Download? _own;
    private readonly IReadOnlyList<Download> _others;
    private readonly GameFolder? _gameFolder;
    private readonly Dictionary<string, string> _gamePathByHash = new(StringComparer.Ordinal);

    public ManifestBuilder(
        (string Name, InstallationFile File)? installationFile, GameFolder? gameFolder, IEnumerable<(string Name, InstallationFile File)>? downloadedFiles = null)
    {
        _gameFolder = gameFolder;
        _own = installationFile is var (name, file) ? new Download(name, file) : null;
        _others = [.. (downloadedFiles ?? []).Where(other => other.Name != _own?.Package.Name).OrderBy(other => other.Name, StringComparer.Ordinal).Select(other => new Download(other.Name, other.File))];
        foreach (var game in gameFolder?.Places().SelectMany(place => place.Files) ?? []) _gamePathByHash.TryAdd(game.Hash, game.Path);
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

    // The version rides the first package, so a mod with no package has none.
    private Manifest Recorded(IReadOnlyList<HashedFile> files, string? version)
    {
        var taken = new Taken(_own);
        var lines = files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal)
            .Select(file => EntryOf(file, taken)).ToList();
        var packages = taken.Packages();
        return new Manifest(packages, [.. lines.Select(line => line.Package == taken.FirstName ? line with { Package = null } : line)], packages.Count > 0 ? version : null);
    }

    private ManifestFile EntryOf(HashedFile file, Taken taken)
    {
        if (_own?.Holds(file) is { } inOwn) return ManifestFile.In(_own.Package.Name, file.Path, inOwn);
        if (_gameFolder is not null && _gamePathByHash.TryGetValue(file.Hash, out var gamePath))
        {
            taken.FromGameFolder(_gameFolder.Name, file);
            return ManifestFile.In(_gameFolder.Name, file.Path, gamePath);
        }
        var holding = _others.Select(other => (Download: other, Path: other.Holds(file))).Where(other => other.Path is not null).OrderBy(other => !taken.Uses(other.Download)).FirstOrDefault();
        if (holding.Path is null) return new ManifestFile(file.Path, _own?.HoldsAtItsPath(file) == true ? new PackageEntry.OtherBytes() : new PackageEntry.NotHeld());
        taken.From(holding.Download);
        return ManifestFile.In(holding.Download.Package.Name, file.Path, holding.Path);
    }

    private sealed class Taken
    {
        private readonly List<Download?> _order = [];
        private readonly List<HashedFile> _fromGame = [];
        private string _gameFolder = string.Empty;

        public Taken(Download? own)
        {
            if (own is not null) _order.Add(own);
        }

        public string? FirstName => _order.Count == 0 ? null : _order[0]?.Package.Name ?? _gameFolder;

        public bool Uses(Download download) => _order.Contains(download);

        public void From(Download download)
        {
            if (!Uses(download)) _order.Add(download);
        }

        public void FromGameFolder(string name, HashedFile file)
        {
            if (_fromGame.Count == 0) _order.Add(null);
            _gameFolder = name;
            _fromGame.Add(file);
        }

        public List<ManifestPackage> Packages() =>
            [.. _order.Select(download => download?.Package ?? (ManifestPackage)new ManifestPackage.GameFolder(_gameFolder, FileHash.OfFilesTaken(_fromGame)))];
    }

    private sealed class Download(string name, InstallationFile file)
    {
        private readonly ILookup<string, HashedEntry> _byHash = file.Entries.ToLookup(entry => entry.Hash, StringComparer.Ordinal);
        private readonly Dictionary<string, HashedEntry> _byPath = ByPath(file.Entries);

        public ManifestPackage.InstallationFile Package { get; } = new(name, file.Size, file.Hash, file.Page);

        public string? Holds(HashedFile held)
        {
            var holding = _byHash[held.Hash].ToList();
            if (holding.Count == 0) return null;
            return (_byPath.TryGetValue(held.Path, out var samePath) && samePath.Hash == held.Hash ? samePath : holding[0]).Path;
        }

        public bool HoldsAtItsPath(HashedFile held) => _byPath.ContainsKey(held.Path);

        private static Dictionary<string, HashedEntry> ByPath(IEnumerable<HashedEntry> entries)
        {
            Dictionary<string, HashedEntry> byPath = new(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in entries) byPath.TryAdd(entry.Path, entry);
            return byPath;
        }
    }
}
