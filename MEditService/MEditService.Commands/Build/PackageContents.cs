using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each manifest line's entry in the mod's one package, with the hash that fixes its bytes, and what the package lacks.</summary>
internal sealed class PackageContents(IModFolderRepository repository, Manifest manifest, InstallationFile? installationFile, GameFolder? gameFolder,
    IReadOnlyDictionary<string, string>? unreadableGameFiles = null, string? unreadableInstallationFile = null)
{
    private readonly Dictionary<string, string> _unreadableGameFiles = new(unreadableGameFiles ?? new Dictionary<string, string>(), StringComparer.OrdinalIgnoreCase);

    internal record Lack(string Text)
    {
        internal sealed record InstallationFileMissing(ManifestPackage.InstallationFile Named) : Lack($"installation file '{Named.Name}' is missing");

        internal sealed record GameFileMissing(string Path) : Lack($"game file '{Path}' is missing");

        internal sealed record InstallationFileUnreadable(string Name, string Reason) : Lack($"installation file '{Name}' could not be read: {Reason}");

        internal sealed record GameFileUnreadable(string Path, string Reason) : Lack($"game file '{Path}' could not be read: {Reason}");

        internal sealed record SubmoduleMissing(string Name) : Lack($"its submodule '{Name}' is missing");

        internal sealed record NoHost() : Lack("its package has no host");
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

    private (Handed? Handed, Lack? Lack)? _package;

    public Resolved Resolve()
    {
        List<PackagedFile> sourced = [];
        List<Lack> lacks = [];
        if (manifest.Package is ManifestPackage.InstallationFile named && Package(named).Lack is { } missing) lacks.Add(missing);
        if (manifest.Package is ManifestPackage.SourceRepository { IsSubmodule: false }) lacks.Add(new Lack.NoHost());
        foreach (var file in manifest.Files)
        {
            var (entry, lack) = EntryOf(file);
            if (entry is not null) sourced.Add(entry);
            if (lack is not null) lacks.Add(lack);
        }
        if (lacks.Count == 0 && manifest.Package is ManifestPackage.GameFolder pinned && PinnedLack(pinned, sourced) is { } changed) lacks.Add(changed);
        var built = manifest.Package is ManifestPackage.SourceRepository { IsSubmodule: true } submodule ? submodule.Name : null;
        return new Resolved(sourced, [.. lacks.Distinct()], built);
    }

    private static Lack? PinnedLack(ManifestPackage.GameFolder pinned, IReadOnlyList<PackagedFile> taken) =>
        FileHash.OfFilesTaken(taken.Select(file => new HashedFile(file.Path, file.Hash))) == pinned.Hash
            ? null
            : new Lack($"the files it takes from the game folder '{pinned.Name}' have other bytes");

    private (PackagedFile?, Lack?) EntryOf(ManifestFile file) => manifest.BytesOf(file) switch
    {
        FileBytes.NotHeld => (null, new Lack($"its package does not hold '{file.Path}'")),
        FileBytes.OtherBytes => (null, new Lack($"its package holds '{file.Path}' with other bytes")),
        FileBytes.NoInstallationFile => (null, new Lack($"'{file.Path}' names no installation file")),
        FileBytes.InInstallationFile held when manifest.Package is ManifestPackage.InstallationFile named => EntryOf(file.Path, named, held),
        FileBytes.InGameFolder held => EntryOf(file.Path, held),
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

    private (PackagedFile?, Lack?) EntryOf(string path, FileBytes.InGameFolder held) =>
        gameFolder?.Files.FirstOrDefault(file => string.Equals(file.Path, held.Path, StringComparison.OrdinalIgnoreCase)) is { } game
            ? (new PackagedFile.InGameFolder(path, game.Hash, gameFolder.DataFolder, game.Path), null)
            : (null, GameFileLack(held.Path));

    private Lack GameFileLack(string path) =>
        _unreadableGameFiles.TryGetValue(path, out var why) ? new Lack.GameFileUnreadable(path, why) : new Lack.GameFileMissing(path);

    private (Handed? Handed, Lack? Lack) Package(ManifestPackage.InstallationFile named) => _package ??= Find(named);

    private (Handed?, Lack?) Find(ManifestPackage.InstallationFile named)
    {
        var handed = installationFile is not null && repository.InstallationFileName(installationFile.Path) == named.Name ? installationFile : null;
        if (handed is null)
        {
            return (null, unreadableInstallationFile is { } why ? new Lack.InstallationFileUnreadable(named.Name, why) : new Lack.InstallationFileMissing(named));
        }
        if (!repository.InstallationFileExists(handed.Path)) return (null, new Lack($"installation file '{named.Name}' is not in the downloads folder"));
        if (named.Hash != handed.Hash) return (null, new Lack($"installation file '{named.Name}' has other bytes"));
        Dictionary<string, HashedEntry> entries = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in handed.Entries) entries.TryAdd(entry.Path, entry);
        return (new Handed(handed, entries), null);
    }
}
