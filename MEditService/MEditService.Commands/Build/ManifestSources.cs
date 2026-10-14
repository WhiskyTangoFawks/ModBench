using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>Each manifest line's provider among what a request hands, with the hash that fixes the file's bytes. A
/// provider missing, or holding other bytes than the manifest names, is a lack.</summary>
internal sealed class ManifestSources(
    IModFolderRepository repository, Manifest manifest, IReadOnlyList<InstallationFile> installationFiles, IReadOnlyList<OverriddenGameFile> gameFiles)
{
    internal record Lack(string Text)
    {
        internal sealed record GameFileMissing(string Path) : Lack($"game file '{Path}' is missing");
    }

    internal abstract record Source(string Hash);

    internal sealed record EntrySource(InstallationFile File, string Path, string Hash) : Source(Hash);

    internal sealed record GameSource(OverriddenGameFile File) : Source(File.Hash);

    internal sealed record Resolved(IReadOnlyList<(ManifestFile File, Source Source)> Sourced, IReadOnlyList<Lack> Lacks);

    private sealed record Handed(InstallationFile File, Dictionary<string, HashedEntry> Entries);

    private readonly Dictionary<string, (Handed? Handed, Lack? Lack)> _installationFiles = new(StringComparer.Ordinal);

    /// <summary>Each line's source, and each lack once.</summary>
    public Resolved Resolve(IReadOnlyList<ManifestFile> files)
    {
        List<(ManifestFile, Source)> sourced = [];
        List<Lack> lacks = [];
        foreach (var file in files)
        {
            var (source, lack) = SourceOf(file);
            if (source is not null) sourced.Add((file, source));
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
        if (!_installationFiles.TryGetValue(name, out var found)) _installationFiles[name] = found = InstallationFileNamed(name);
        if (found.Handed is not { } handed) return (null, found.Lack);
        return handed.Entries.TryGetValue(entryPath, out var entry)
            ? (new EntrySource(handed.File, entry.Path, entry.Hash), null)
            : (null, new Lack($"installation file '{name}' holds no '{entryPath}'"));
    }

    private (Handed?, Lack?) InstallationFileNamed(string name)
    {
        var handed = installationFiles.FirstOrDefault(file => repository.InstallationFileName(file.Path) == name);
        if (handed is null || !repository.InstallationFileExists(handed.Path))
            return (null, new Lack($"installation file '{name}' is not in the downloads folder"));
        if (manifest.InstallationFiles.FirstOrDefault(source => source.Name == name)?.Hash != handed.Hash)
            return (null, new Lack($"installation file '{name}' has other bytes"));
        Dictionary<string, HashedEntry> entries = new(StringComparer.OrdinalIgnoreCase);
        foreach (var entry in handed.Entries) entries.TryAdd(entry.Path, entry);
        return (new Handed(handed, entries), null);
    }

    private (Source?, Lack?) GameFileOf(string path)
    {
        var handed = gameFiles.FirstOrDefault(game => string.Equals(game.Path, path, StringComparison.OrdinalIgnoreCase));
        if (handed is null) return (null, new Lack.GameFileMissing(path));
        var named = manifest.GameFiles.FirstOrDefault(source => string.Equals(source.Name, path, StringComparison.OrdinalIgnoreCase));
        return named?.Hash == handed.Hash ? (new GameSource(handed), null) : (null, new Lack($"game file '{path}' has other bytes"));
    }
}
