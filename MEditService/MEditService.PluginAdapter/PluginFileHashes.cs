using System.Collections.Concurrent;

namespace MEditService.PluginAdapter;

/// <summary>Each plugin file's hash, kept by its stamp (ADR-0009).</summary>
public sealed class PluginFileHashes(TimeProvider timeProvider)
{
    // A file system stamps a change with a clock coarser than a hash is quick, and a network share's
    // clock is not this machine's: a stamp this recent may not change for a write that follows it.
    private static readonly TimeSpan SettledAfter = TimeSpan.FromSeconds(2);

    private readonly ConcurrentDictionary<string, (FileStamp Stamp, string Hash)> _known = new(StringComparer.Ordinal);

    /// <summary>Null on <see cref="PluginBinaryHash.OfFile"/>'s no-evidence terms.</summary>
    public string? Of(string path)
    {
        var stamp = FileStamp.Of(path);
        if (stamp is { } current && _known.TryGetValue(path, out var known) && known.Stamp == current)
            return known.Hash;

        var readFrom = timeProvider.GetUtcNow();
        var hash = PluginBinaryHash.OfFile(path);
        if (stamp is { } before && hash is not null && before.ChangedBefore(readFrom - SettledAfter))
            _known[path] = (before, hash);
        else
            _known.TryRemove(path, out _);
        return hash;
    }
}
