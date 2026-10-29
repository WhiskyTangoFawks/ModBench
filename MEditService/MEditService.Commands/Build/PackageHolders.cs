using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The files a package holds, looked up by hash, each at its path in the package and the path in the folder it is for.</summary>
internal sealed class Holder(string name, IReadOnlyCollection<(string Path, string Hash, string PathInFolder)> files)
{
    private readonly ILookup<string, (string Path, string PathInFolder)> _byHash =
        files.ToLookup(file => file.Hash, file => (file.Path, file.PathInFolder), StringComparer.Ordinal);
    private readonly HashSet<string> _pathsInFolder = files.Select(file => file.PathInFolder).ToHashSet(StringComparer.OrdinalIgnoreCase);

    public string Name { get; } = name;

    public string? PathHolding(HashedFile held) => OwnPathHolding(held) ?? _byHash[held.Hash].Select(file => file.Path).FirstOrDefault();

    /// <summary>The path of the file held for <paramref name="held"/>'s path, when it has its bytes.</summary>
    public string? OwnPathHolding(HashedFile held) =>
        _byHash[held.Hash].Where(file => string.Equals(file.PathInFolder, held.Path, StringComparison.OrdinalIgnoreCase)).Select(file => file.Path).FirstOrDefault();

    public bool HoldsAPathOf(HashedFile held) => _pathsInFolder.Contains(held.Path);
}

internal sealed class DownloadedFile(string name, InstallationFile file)
{
    public Holder Holder { get; } = new(name, [.. file.Entries.Select(entry => (entry.Path, entry.Hash, entry.Path))]);

    public ManifestPackage.InstallationFile Package { get; } = new(name, file.Size, file.Hash, file.Page);

    /// <summary>One holder per file name, the first by hash, built once for a request.</summary>
    public static IReadOnlyList<DownloadedFile> Of(IEnumerable<(string Name, InstallationFile File)> files) =>
        [.. files
            .OrderBy(file => file.Name, StringComparer.Ordinal).ThenBy(file => file.File.Hash, StringComparer.Ordinal)
            .DistinctBy(file => file.Name).Select(file => new DownloadedFile(file.Name, file.File))];
}
