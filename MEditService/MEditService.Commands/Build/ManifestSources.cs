using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each manifest line's provider among what a request hands, with the hash that fixes the file's bytes. A
/// source the manifest names that is missing, or holds other bytes than the manifest names, is a lack.</summary>
internal sealed class ManifestSources(
    IModFolderRepository repository, Manifest manifest, IReadOnlyList<InstallationFile> installationFiles, IReadOnlyList<OverriddenGameFile> gameFiles)
{
    internal record Lack(string Text)
    {
        internal sealed record GameFileMissing(string Path) : Lack($"game file '{Path}' is missing");
    }

    internal abstract record Source(string Hash);

    internal sealed record EntrySource(InstallationFile File, string Path, string Hash) : Source(Hash);

    internal sealed record GameSource(string Path, string Hash) : Source(Hash);

    /// <summary>A file of the mod folder, by its path, and where its line says it comes from.</summary>
    internal sealed record SourcedFile(string Path, Source Source);

    internal sealed record Resolved(IReadOnlyList<SourcedFile> Files, IReadOnlyList<Lack> Lacks);

    private sealed record Handed(InstallationFile File, Dictionary<string, HashedEntry> Entries);

    private readonly Dictionary<string, (Handed? Handed, Lack? Lack)> _installationFiles = new(StringComparer.Ordinal);

    /// <summary>Each line's source, and each lack once: of the sources the manifest names, then of its lines.</summary>
    public Resolved Resolve()
    {
        List<SourcedFile> sourced = [];
        List<Lack> lacks =
        [
            .. manifest.InstallationFiles.Select(source => InstallationFileNamed(source.Name).Lack).OfType<Lack>(),
            .. manifest.GameFiles.Select(source => GameFileOf(source.Name).Lack).OfType<Lack>(),
        ];
        foreach (var file in manifest.Files)
        {
            var (source, lack) = SourceOf(file);
            if (source is not null) sourced.Add(new SourcedFile(file.Path, source));
            if (lack is not null) lacks.Add(lack);
        }
        return new Resolved(sourced, [.. lacks.Distinct()]);
    }

    private (Source?, Lack?) SourceOf(ManifestFile file) => file.Provider switch
    {
        FileProvider.NoProvider => (null, new Lack($"'{file.Path}' has no provider")),
        FileProvider.FirstInstallationFile => manifest.InstallationFiles is [var first, ..]
            ? EntryOf(first.Name, file.Path)
            : (null, new Lack($"'{file.Path}' names no installation file")),
        FileProvider.InstallationFileEntry entry => EntryOf(entry.InstallationFile, entry.Path),
        FileProvider.GameFile game => GameFileOf(game.Path),
        _ => throw new ArgumentOutOfRangeException(nameof(file), file.Provider, null),
    };

    private (Source?, Lack?) EntryOf(string name, string entryPath)
    {
        var (handed, lack) = InstallationFileNamed(name);
        if (handed is null) return (null, lack);
        return handed.Entries.TryGetValue(entryPath, out var entry)
            ? (new EntrySource(handed.File, entry.Path, entry.Hash), null)
            : (null, new Lack($"installation file '{name}' holds no '{entryPath}'"));
    }

    private (Handed? Handed, Lack? Lack) InstallationFileNamed(string name)
    {
        if (_installationFiles.TryGetValue(name, out var found)) return found;
        return _installationFiles[name] = Find();

        (Handed?, Lack?) Find()
        {
            var handed = installationFiles.FirstOrDefault(file => repository.InstallationFileName(file.Path) == name);
            if (handed is null) return (null, new Lack($"the mod manager records no installation file '{name}' for it"));
            if (!repository.InstallationFileExists(handed.Path)) return (null, new Lack($"installation file '{name}' is not in the downloads folder"));
            if (manifest.InstallationFiles.FirstOrDefault(source => source.Name == name)?.Hash != handed.Hash)
                return (null, new Lack($"installation file '{name}' has other bytes"));
            Dictionary<string, HashedEntry> entries = new(StringComparer.OrdinalIgnoreCase);
            foreach (var entry in handed.Entries) entries.TryAdd(entry.Path, entry);
            return (new Handed(handed, entries), null);
        }
    }

    private (Source? Source, Lack? Lack) GameFileOf(string path)
    {
        var handed = gameFiles.FirstOrDefault(game => string.Equals(game.Path, path, StringComparison.OrdinalIgnoreCase));
        if (handed is null) return (null, new Lack.GameFileMissing(path));
        var named = manifest.GameFiles.FirstOrDefault(source => string.Equals(source.Name, path, StringComparison.OrdinalIgnoreCase));
        return named?.Hash == handed.Hash
            ? (new GameSource(handed.Path, handed.Hash), null)
            : (null, new Lack($"game file '{path}' has other bytes"));
    }
}
