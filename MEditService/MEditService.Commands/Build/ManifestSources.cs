using MEditService.ModFolderAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each manifest line's entry in the mod's one package, with the hash that fixes its bytes, and what the package lacks.</summary>
internal sealed class ManifestSources(IModFolderRepository repository, Manifest manifest, IReadOnlyList<InstallationFile> installationFiles)
{
    internal record Lack(string Text)
    {
        internal sealed record InstallationFileMissing(string Name) : Lack($"installation file '{Name}' is missing");
    }

    /// <summary>A file of the mod folder, by its path, and the entry of the installation file that holds its bytes.</summary>
    internal sealed record SourcedFile(string Path, InstallationFile File, string EntryPath, string Hash);

    /// <summary>Built is the source and commit that build the mod's files, none when its package is no source mod.</summary>
    internal sealed record Resolved(
        IReadOnlyList<SourcedFile> Files, IReadOnlyList<Lack> Lacks, SharedSource? Built);

    private sealed record Handed(InstallationFile File, Dictionary<string, HashedEntry> Entries);

    private (Handed? Handed, Lack? Lack)? _package;

    public Resolved Resolve()
    {
        List<SourcedFile> sourced = [];
        List<Lack> lacks = [];
        if (manifest.Package is ManifestPackage.InstallationFile named && Package(named).Lack is { } missing) lacks.Add(missing);
        foreach (var file in manifest.Files)
        {
            var (entry, lack) = EntryOf(file);
            if (entry is not null) sourced.Add(entry);
            if (lack is not null) lacks.Add(lack);
        }
        var built = manifest.Package is ManifestPackage.SourceMod sourceMod ? new SharedSource(sourceMod.Remote, sourceMod.Commit) : null;
        return new Resolved(sourced, [.. lacks.Distinct()], built);
    }

    private (SourcedFile?, Lack?) EntryOf(ManifestFile file) => manifest.BytesOf(file) switch
    {
        FileBytes.NotHeld => (null, new Lack($"its package does not hold '{file.Path}'")),
        FileBytes.NoInstallationFile => (null, new Lack($"'{file.Path}' names no installation file")),
        FileBytes.InInstallationFile held when manifest.Package is ManifestPackage.InstallationFile named => EntryOf(file.Path, named, held),
        FileBytes.AtCommit => (null, null),
        var other => throw new ArgumentOutOfRangeException(nameof(file), other, null),
    };

    private (SourcedFile?, Lack?) EntryOf(string path, ManifestPackage.InstallationFile named, FileBytes.InInstallationFile held)
    {
        var (handed, lack) = Package(named);
        if (handed is null) return (null, lack);
        return handed.Entries.TryGetValue(held.Path, out var entry)
            ? (new SourcedFile(path, handed.File, entry.Path, entry.Hash), null)
            : (null, new Lack($"installation file '{held.Name}' holds no '{held.Path}'"));
    }

    private (Handed? Handed, Lack? Lack) Package(ManifestPackage.InstallationFile named) => _package ??= Find(named);

    private (Handed?, Lack?) Find(ManifestPackage.InstallationFile named)
    {
        var handed = installationFiles.FirstOrDefault(file => repository.InstallationFileName(file.Path) == named.Name);
        if (handed is null) return (null, new Lack.InstallationFileMissing(named.Name));
        if (!repository.InstallationFileExists(handed.Path)) return (null, new Lack($"installation file '{named.Name}' is not in the downloads folder"));
        if (named.Hash != handed.Hash) return (null, new Lack($"installation file '{named.Name}' has other bytes"));
        Dictionary<string, HashedEntry> entries = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in handed.Entries) entries.TryAdd(entry.Path, entry);
        return (new Handed(handed, entries), null);
    }
}
