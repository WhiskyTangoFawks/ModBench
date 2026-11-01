using MEditService.ModFolderAdapter;

namespace MEditService.Commands.Build;

/// <summary>The writes of one build into a mod folder. A path the configuration excludes, or one in a folder it
/// excludes, is written with the mod manager's exclusion mark on the excluded name. A path its manifest ignores is not written.</summary>
internal sealed class FolderWrite(
    IModFolderRepository repository, string folder, IReadOnlyList<string> exclude, IReadOnlyList<string> ignore, string exclusionMark)
{
    private readonly HashSet<string> _excluded = exclude.ToHashSet(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _ignored = ignore.ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>Whether the manifest ignores the path, or a folder above it.</summary>
    public bool Ignores(string path)
    {
        var segments = path.Split('/');
        return Enumerable.Range(1, segments.Length).Any(depth => _ignored.Contains(string.Join('/', segments[..depth])));
    }

    public string PathOf(string path)
    {
        var segments = path.Split('/');
        for (var depth = 1; depth <= segments.Length; depth++)
        {
            if (!_excluded.Contains(string.Join('/', segments[..depth]))) continue;
            segments[depth - 1] = repository.ExcludedName(segments[depth - 1], exclusionMark);
            return string.Join('/', segments);
        }

        return path;
    }

    public void Write(string path, Action<Stream> write) => repository.WriteFile(folder, PathOf(path), write);
}
