using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each manifest line's entry in its package, with the hash that fixes its bytes, and what the package lacks.</summary>
internal sealed class PackageContents(IModFolderRepository repository, Manifest manifest, IReadOnlyList<InstallationFile> installationFiles, GameFolder? gameFolder,
    IReadOnlyDictionary<string, string>? unreadableGameFiles = null, IReadOnlyDictionary<string, string>? unreadableInstallationFiles = null)
{
    private readonly Dictionary<string, string> _unreadableGameFiles = new(unreadableGameFiles ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);

    internal record Lack(string Text)
    {
        internal sealed record InstallationFileMissing(ManifestPackage.InstallationFile Named) : Lack($"installation file '{Named.Name}' is missing");

        internal sealed record GameFileMissing(string Path) : Lack($"game file '{Path}' is missing");

        internal sealed record InstallationFileUnreadable(string Name, string Reason) : Lack($"installation file '{Name}' could not be read: {Reason}");

        internal sealed record GameFileUnreadable(string Path, string Reason) : Lack($"game file '{Path}' could not be read: {Reason}");

        internal sealed record SubmoduleMissing(string Name) : Lack($"its submodule '{Name}' is missing");

        internal sealed record GameFolderOtherBytes(string Name) : Lack($"the files it takes from the game folder '{Name}' have other bytes");

        internal sealed record GameFolderDepots(string Name, IReadOnlyList<GameDepot> Depots)
            : Lack($"the game folder '{Name}' is {string.Join(" and ", Depots.Select(depot => $"depot {depot.Id} at version {depot.Version}"))}");

        internal sealed record NoHost() : Lack("its package has no host");

        internal sealed record NoTask(string Why) : Lack(Why);
    }

    /// <summary>A file of the mod folder, by its path, and where its package holds its bytes.</summary>
    internal abstract record PackagedFile(string Path, string Hash)
    {
        /// <summary>The entry of the installation file that holds the bytes.</summary>
        internal sealed record InInstallationFile(string Path, string Hash, InstallationFile File, string EntryPath) : PackagedFile(Path, Hash);

        /// <summary>The game file, by its path as the game folder names it, that holds the bytes.</summary>
        internal sealed record InGameFolder(string Path, string Hash, string DataFolder, string GamePath) : PackagedFile(Path, Hash);
    }

    /// <summary>Built names the submodule whose build writes the files, none when its package is no submodule.</summary>
    internal sealed record Resolved(IReadOnlyList<PackagedFile> Files, IReadOnlyList<Lack> Lacks, string? Built);

    private sealed record Handed(InstallationFile File, Dictionary<string, HashedEntry> Entries);

    private readonly Dictionary<string, (Handed? Handed, Lack? Lack)> _packages = [];

    public Resolved Resolve()
    {
        var places = gameFolder?.Places().ToList() ?? [];
        var first = ResolveIn(places);
        if (first.Lacks.Count == 0) return first;
        return places.Skip(1).Select((_, skipped) => ResolveIn([.. places.Skip(skipped + 1), .. places.Take(skipped + 1)])).FirstOrDefault(resolved => resolved.Lacks.Count == 0) ?? first;
    }

    private Resolved ResolveIn(IReadOnlyList<GameFolder> places)
    {
        List<PackagedFile> sourced = [];
        List<Lack> lacks = [];
        foreach (var named in manifest.Packages.OfType<ManifestPackage.InstallationFile>())
        {
            if (Package(named).Lack is { } missing) lacks.Add(missing);
        }
        if (manifest.Package is ManifestPackage.SourceRepository { IsSubmodule: false }) lacks.Add(new Lack.NoHost());
        foreach (var file in manifest.Files)
        {
            var (entry, lack) = EntryOf(file, places);
            if (entry is not null) sourced.Add(entry);
            if (lack is not null) lacks.Add(lack);
        }
        if (lacks.Count == 0) lacks.AddRange(manifest.Packages.OfType<ManifestPackage.GameFolder>().Select(pinned => PinnedLack(pinned, sourced)).OfType<Lack>());
        if (lacks.Any(lack => lack is Lack.GameFileMissing or Lack.GameFolderOtherBytes))
        {
            lacks.AddRange(manifest.Packages.OfType<ManifestPackage.GameFolder>().Where(named => named.Depots.Count > 0).Select(named => new Lack.GameFolderDepots(named.Name, named.Depots)));
        }
        var built = manifest.Package is ManifestPackage.SourceRepository { IsSubmodule: true } submodule ? submodule.Name : null;
        return new Resolved(sourced, [.. lacks.Distinct()], built);
    }

    private static Lack.GameFolderOtherBytes? PinnedLack(ManifestPackage.GameFolder pinned, IReadOnlyList<PackagedFile> taken) =>
        FileHash.OfFilesTaken(taken.OfType<PackagedFile.InGameFolder>().Select(file => new HashedFile(file.Path, file.Hash))) == pinned.Hash
            ? null
            : new Lack.GameFolderOtherBytes(pinned.Name);

    private (PackagedFile?, Lack?) EntryOf(ManifestFile file, IReadOnlyList<GameFolder> places) => manifest.BytesOf(file) switch
    {
        FileBytes.NotHeld => (null, new Lack($"its package does not hold '{file.Path}'")),
        FileBytes.OtherBytes => (null, new Lack($"its package holds '{file.Path}' with other bytes")),
        FileBytes.NoInstallationFile => (null, new Lack($"'{file.Path}' names no installation file")),
        FileBytes.InInstallationFile held => EntryOf(file.Path, manifest.Packages.OfType<ManifestPackage.InstallationFile>().Single(package => package.Name == held.Name), held),
        FileBytes.InGameFolder held => EntryOf(file.Path, held, places),
        FileBytes.Built or FileBytes.MadeByStep => (null, null),
        var other => throw new ArgumentOutOfRangeException(nameof(file), other, null),
    };

    private (PackagedFile?, Lack?) EntryOf(string path, ManifestPackage.InstallationFile named, FileBytes.InInstallationFile held)
    {
        var (handed, lack) = Package(named);
        if (handed is null) return (null, lack);
        return handed.Entries.TryGetValue(held.Path, out var entry)
            ? (new PackagedFile.InInstallationFile(path, entry.Hash, handed.File, entry.Path), null)
            : (null, new Lack($"installation file '{held.Name}' holds no '{held.Path}'"));
    }

    private (PackagedFile?, Lack?) EntryOf(string path, FileBytes.InGameFolder held, IReadOnlyList<GameFolder> places)
    {
        foreach (var place in places)
        {
            if (place.Files.FirstOrDefault(file => string.Equals(file.Path, held.Path, StringComparison.OrdinalIgnoreCase)) is { } game)
                return (new PackagedFile.InGameFolder(path, game.Hash, place.DataFolder, game.Path), null);
        }
        return (null, GameFileLack(held.Path));
    }

    private Lack GameFileLack(string path) =>
        _unreadableGameFiles.TryGetValue(path, out var why) ? new Lack.GameFileUnreadable(path, why) : new Lack.GameFileMissing(path);

    private (Handed? Handed, Lack? Lack) Package(ManifestPackage.InstallationFile named)
    {
        if (!_packages.TryGetValue(named.Name, out var found)) _packages[named.Name] = found = Find(named);
        return found;
    }

    private (Handed?, Lack?) Find(ManifestPackage.InstallationFile named)
    {
        var (handed, lack) = new HandedInstallationFiles(repository, installationFiles).Of(named, unreadableInstallationFiles);
        if (handed is null) return (null, lack);
        Dictionary<string, HashedEntry> entries = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in handed.Entries) entries.TryAdd(entry.Path, entry);
        return (new Handed(handed, entries), null);
    }
}
