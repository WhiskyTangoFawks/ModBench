using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>A mod's manifest from the mod as it is. Each file is taken by its hash from the mod's installation file, then from
/// the game's places, then from another downloaded file.</summary>
internal sealed class ManifestBuilder
{
    private readonly DownloadedFile? _own;
    private readonly IReadOnlyList<DownloadedFile> _others;
    private readonly IReadOnlyList<(Holder Holder, IReadOnlyList<GameDepot> Depots)> _places;
    private readonly Holder? _game;

    public ManifestBuilder((string Name, InstallationFile File)? installationFile, GameFolder? gameFolder, IReadOnlyList<DownloadedFile> downloadedFiles)
    {
        _own = installationFile is var (name, file) ? new DownloadedFile(name, file) : null;
        _others = [.. downloadedFiles.Where(other => other.Package.Name != _own?.Package.Name)];
        _game = gameFolder is null ? null : new Holder(gameFolder.Name, [.. gameFolder.Places().SelectMany(place => place.Files.Select(HeldFor))]);
        _places = gameFolder is null ? [] : [.. gameFolder.Places().Select(place => (new Holder(gameFolder.Name, [.. place.Files.Select(HeldFor)]), place.Depots ?? []))];
    }

    private static (string Path, string Hash, string PathInFolder) HeldFor(GameFile game) => (game.Path, game.Hash, game.PathInFolder ?? game.Path);

    /// <summary>What <paramref name="held"/> says that no folder shows, its steps and the files they make, kept as written
    /// (ADR-0022).</summary>
    public Manifest Manifest(IReadOnlyList<HashedFile> files, string? version, Manifest? held)
    {
        var madeByStep = held?.Files.Where(line => line.Entry is PackageEntry.MadeByStep).Select(line => line.Path).ToHashSet(StringComparer.Ordinal) ?? [];
        var recorded = Recorded([.. files.Where(file => !madeByStep.Contains(file.Path))], version);
        return (held ?? recorded) with
        {
            Packages = [.. recorded.Packages.Select(package => KeepingDepots(package, held))],
            Version = recorded.Version,
            Files = [.. recorded.Files, .. madeByStep.Select(path => new ManifestFile(path, new PackageEntry.MadeByStep()))],
        };
    }

    // A version recorded with a hash holds the files that hash pins, so the depots stay while the files taken do, and when a
    // place records none, as a copy of the game does.
    private static ManifestPackage KeepingDepots(ManifestPackage package, Manifest? held) =>
        package is ManifestPackage.GameFolder recorded
        && held?.Packages.OfType<ManifestPackage.GameFolder>().FirstOrDefault(named => named.Name == recorded.Name) is { Depots.Count: > 0 } kept
        && (recorded.Depots.Count == 0 || kept.Hash == recorded.Hash)
            ? recorded with { Depots = kept.Depots }
            : package;

    // The version rides the first package, so a mod with no package has none.
    private Manifest Recorded(IReadOnlyList<HashedFile> files, string? version)
    {
        var ordered = files.OrderBy(file => file.Path, StringComparer.OrdinalIgnoreCase).ThenBy(file => file.Path, StringComparer.Ordinal).ToList();
        var sourcing = new Sourcing(_own);
        sourcing.Take(_own?.Holder, ordered);
        TakeFromThePlacesOfTheGame(sourcing, ordered);
        TakeFromOtherDownloadedFiles(sourcing, ordered);
        sourcing.RecordUnsourced(ordered);
        return sourcing.Manifest(ordered, version);
    }

    private void TakeFromThePlacesOfTheGame(Sourcing sourcing, IReadOnlyList<HashedFile> ordered)
    {
        var wanting = sourcing.Unsourced(ordered);
        List<HashedFile> taken = [];
        List<GameDepot> depots = [];
        var places = _places
            .OrderByDescending(place => wanting.Count(file => place.Holder.PathHolding(file) is not null)).ThenByDescending(place => place.Depots.Count > 0).ToList();
        foreach (var ownPathOnly in (bool[])[true, false])
        {
            foreach (var (holder, placeDepots) in places)
            {
                var takenHere = sourcing.Take(holder, sourcing.Unsourced(wanting), ownPathOnly);
                if (takenHere.Count == 0) continue;
                taken.AddRange(takenHere);
                depots.AddRange(placeDepots.Except(depots));
            }
        }
        if (taken.Count > 0 && _game is { } game) sourcing.Packages.Add((game, new ManifestPackage.GameFolder(game.Name, FileHash.OfFilesTaken(taken), depots)));
    }

    private void TakeFromOtherDownloadedFiles(Sourcing sourcing, IReadOnlyList<HashedFile> ordered)
    {
        List<DownloadedFile> used = [];
        foreach (var file in sourcing.Unsourced(ordered))
        {
            var holding = _others.Select(other => (Other: other, Path: other.Holder.PathHolding(file)))
                .Where(candidate => candidate.Path is not null).OrderBy(candidate => !used.Contains(candidate.Other)).FirstOrDefault();
            if (holding.Path is null) continue;
            if (!used.Contains(holding.Other)) used.Add(holding.Other);
            sourcing.Lines[file.Path] = ManifestFile.In(holding.Other.Holder.Name, file.Path, holding.Path);
        }
        sourcing.Packages.AddRange(used.Select(other => (other.Holder, (ManifestPackage)other.Package)));
    }

    private sealed class Sourcing
    {
        public Sourcing(DownloadedFile? own)
        {
            if (own is not null) Packages.Add((own.Holder, own.Package));
        }

        public List<(Holder Holder, ManifestPackage Package)> Packages { get; } = [];

        public Dictionary<string, ManifestFile> Lines { get; } = [];

        public List<HashedFile> Unsourced(IEnumerable<HashedFile> files) => [.. files.Where(file => !Lines.ContainsKey(file.Path))];

        public List<HashedFile> Take(Holder? holder, IEnumerable<HashedFile> files, bool ownPathOnly = false)
        {
            List<HashedFile> taken = [];
            if (holder is null) return taken;
            foreach (var file in files)
            {
                if ((ownPathOnly ? holder.OwnPathHolding(file) : holder.PathHolding(file)) is not { } path) continue;
                Lines[file.Path] = ManifestFile.In(holder.Name, file.Path, path);
                taken.Add(file);
            }
            return taken;
        }

        public void RecordUnsourced(IEnumerable<HashedFile> files)
        {
            foreach (var file in Unsourced(files))
            {
                var holding = Packages.Select(package => package.Holder).FirstOrDefault(holder => holder.HoldsAPathOf(file));
                Lines[file.Path] = holding is null
                    ? new ManifestFile(file.Path, new PackageEntry.NotHeld())
                    : new ManifestFile(file.Path, new PackageEntry.OtherBytes(), holding.Name);
            }
        }

        public Manifest Manifest(IEnumerable<HashedFile> ordered, string? version)
        {
            var first = Packages.Count > 0 ? Packages[0].Holder.Name : null;
            return new Manifest(
                [.. Packages.Select(package => package.Package)],
                [.. ordered.Select(file => Lines[file.Path]).Select(line => line.Package == first ? line with { Package = null } : line)],
                Packages.Count > 0 ? version : null);
        }
    }
}
