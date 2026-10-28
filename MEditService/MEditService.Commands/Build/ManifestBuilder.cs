using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is. Each file is taken by its hash from the mod's installation file, then from
/// one place of the game, then from another downloaded file.</summary>
internal sealed class ManifestBuilder
{
    private readonly DownloadedFile? _own;
    private readonly IReadOnlyList<DownloadedFile> _others;
    private readonly IReadOnlyList<Holder> _places;

    public ManifestBuilder(
        (string Name, InstallationFile File)? installationFile, GameFolder? gameFolder, IEnumerable<(string Name, InstallationFile File)> downloadedFiles)
    {
        _own = installationFile is var (name, file) ? new DownloadedFile(name, file) : null;
        _others = [.. downloadedFiles
            .OrderBy(other => other.Name, StringComparer.Ordinal).ThenBy(other => other.File.Hash, StringComparer.Ordinal)
            .DistinctBy(other => other.Name).Where(other => other.Name != _own?.Holder.Name)
            .Select(other => new DownloadedFile(other.Name, other.File))];
        _places = gameFolder is null ? [] : [.. gameFolder.Places().Select(place => new Holder(gameFolder.Name, [.. place.Files.Select(game => (game.Path, game.Hash))]))];
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
        var ordered = files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal).ToList();
        List<(Holder Holder, ManifestPackage Package)> packages = _own is null ? [] : [(_own.Holder, _own.Package)];
        Dictionary<string, ManifestFile> lines = [];

        TakeFrom(_own?.Holder, ordered, lines);
        var wanting = ordered.Where(file => !lines.ContainsKey(file.Path)).ToList();

        if (_places.MaxBy(place => wanting.Count(file => place.PathHolding(file) is not null)) is { } place)
        {
            var taken = TakeFrom(place, wanting, lines);
            if (taken.Count > 0) packages.Add((place, new ManifestPackage.GameFolder(place.Name, FileHash.OfFilesTaken(taken))));
        }
        wanting = [.. wanting.Where(file => !lines.ContainsKey(file.Path))];

        List<DownloadedFile> used = [];
        foreach (var file in wanting)
        {
            var holding = _others.Where(other => other.Holder.PathHolding(file) is not null).OrderBy(other => !used.Contains(other)).FirstOrDefault();
            if (holding is null) continue;
            if (!used.Contains(holding)) used.Add(holding);
            lines[file.Path] = ManifestFile.In(holding.Holder.Name, file.Path, holding.Holder.PathHolding(file) ?? file.Path);
        }
        packages.AddRange(used.Select(other => (other.Holder, (ManifestPackage)other.Package)));

        foreach (var file in wanting.Where(file => !lines.ContainsKey(file.Path)))
        {
            var holdingItsPath = packages.Select(package => package.Holder).FirstOrDefault(holder => holder.HoldsItsPath(file));
            lines[file.Path] = holdingItsPath is null
                ? new ManifestFile(file.Path, new PackageEntry.NotHeld())
                : new ManifestFile(file.Path, new PackageEntry.OtherBytes(), holdingItsPath.Name);
        }

        var first = packages.Count > 0 ? packages[0].Holder.Name : null;
        return new Manifest(
            [.. packages.Select(package => package.Package)],
            [.. ordered.Select(file => lines[file.Path]).Select(line => line.Package == first ? line with { Package = null } : line)],
            packages.Count > 0 ? version : null);
    }

    private static List<HashedFile> TakeFrom(Holder? holder, IEnumerable<HashedFile> files, Dictionary<string, ManifestFile> lines)
    {
        List<HashedFile> taken = [];
        foreach (var file in files)
        {
            if (holder?.PathHolding(file) is not { } path) continue;
            lines[file.Path] = ManifestFile.In(holder.Name, file.Path, path);
            taken.Add(file);
        }
        return taken;
    }

    private sealed class DownloadedFile(string name, InstallationFile file)
    {
        public Holder Holder { get; } = new(name, [.. file.Entries.Select(entry => (entry.Path, entry.Hash))]);

        public ManifestPackage.InstallationFile Package { get; } = new(name, file.Size, file.Hash, file.Page);
    }

    private sealed class Holder(string name, IReadOnlyCollection<(string Path, string Hash)> files)
    {
        private readonly ILookup<string, string> _pathsByHash = files.ToLookup(file => file.Hash, file => file.Path, StringComparer.Ordinal);
        private readonly HashSet<string> _paths = files.Select(file => file.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);

        public string Name { get; } = name;

        public string? PathHolding(HashedFile held)
        {
            var paths = _pathsByHash[held.Hash];
            return paths.FirstOrDefault(path => string.Equals(path, held.Path, StringComparison.OrdinalIgnoreCase)) ?? paths.FirstOrDefault();
        }

        public bool HoldsItsPath(HashedFile held) => _paths.Contains(held.Path);
    }
}
