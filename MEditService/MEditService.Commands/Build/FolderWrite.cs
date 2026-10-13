using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The writes of one build into a mod folder. A path the configuration excludes, or one in a folder it
/// excludes, is written with the mod manager's suffix on the excluded name.</summary>
internal sealed class FolderWrite(IModFolderRepository repository, string folder, IReadOnlyList<string> exclude, string excludedSuffix)
{
    private readonly HashSet<string> _excluded = exclude.ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>Each path written that held other bytes, as it is named in the folder.</summary>
    public List<string> Overwritten { get; } = [];

    public string PathOf(string path)
    {
        var segments = path.Split('/');
        for (var depth = 1; depth <= segments.Length; depth++)
        {
            if (!_excluded.Contains(string.Join('/', segments[..depth]))) continue;
            segments[depth - 1] += excludedSuffix;
            return string.Join('/', segments);
        }

        return path;
    }

    public void Write(string path, Action<Stream> write)
    {
        var at = PathOf(path);
        if (repository.WriteFile(folder, at, write)) Overwritten.Add(at);
    }
}
