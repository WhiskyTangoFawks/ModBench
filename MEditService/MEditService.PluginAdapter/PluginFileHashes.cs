using MEditService.RepositoriesLib;

namespace MEditService.PluginAdapter;

/// <summary>Each plugin file's hash, kept by its stamp (ADR-0003).</summary>
internal sealed class PluginFileHashes(TimeProvider timeProvider)
{
    private readonly StampGatedMemo<string> _known = new(timeProvider);

    /// <summary>Null on <see cref="PluginBinaryHash.OfFile"/>'s no-evidence terms.</summary>
    internal string? Of(string path) => _known.Of(path, () => PluginBinaryHash.OfFile(path));

    internal void Keep(IReadOnlySet<string> paths) => _known.Retain(paths);
}
