using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The files a package holds, looked up by hash.</summary>
internal sealed class Holder(string name, IReadOnlyCollection<(string Path, string Hash)> files, bool keptBelowFolders = false)
{
    private readonly ILookup<string, string> _pathsByHash = files.ToLookup(file => file.Hash, file => file.Path, StringComparer.Ordinal);
    private readonly HashSet<string> _paths = files.Select(file => file.Path).ToHashSet(StringComparer.OrdinalIgnoreCase);

    public string Name { get; } = name;

    public string? PathHolding(HashedFile held)
    {
        var paths = _pathsByHash[held.Hash];
        return paths.FirstOrDefault(path => string.Equals(path, held.Path, StringComparison.OrdinalIgnoreCase)) ?? paths.FirstOrDefault();
    }

    /// <summary>Whether the package has a file at the path of <paramref name="held"/>; a place of the game also below any of
    /// its folders, in it or its Data, as a mod folder holds Data's files.</summary>
    public bool HoldsAPathOf(HashedFile held)
    {
        if (!keptBelowFolders) return _paths.Contains(held.Path);
        var segments = held.Path.Split('/');
        return segments.Select((_, skipped) => string.Join('/', segments.Skip(skipped))).Any(below => _paths.Contains(below) || _paths.Contains($"Data/{below}"));
    }
}

internal sealed class DownloadedFile(string name, InstallationFile file)
{
    public Holder Holder { get; } = new(name, [.. file.Entries.Select(entry => (entry.Path, entry.Hash))]);

    public ManifestPackage.InstallationFile Package { get; } = new(name, file.Size, file.Hash, file.Page);

    /// <summary>One holder per file name, the first by hash, built once for a request.</summary>
    public static IReadOnlyList<DownloadedFile> Of(IEnumerable<(string Name, InstallationFile File)> files) =>
        [.. files
            .OrderBy(file => file.Name, StringComparer.Ordinal).ThenBy(file => file.File.Hash, StringComparer.Ordinal)
            .DistinctBy(file => file.Name).Select(file => new DownloadedFile(file.Name, file.File))];
}
