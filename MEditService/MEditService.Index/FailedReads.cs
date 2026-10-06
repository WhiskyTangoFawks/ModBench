using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, ReadFrom?> _failed = new(PluginAddress.Comparer);

    /// <summary>What a read reads from: the binary's hash, and for a plugin with a tree, each
    /// document's content stamp, or the doubly claimed FormKey the tree named instead (ADR-0003).</summary>
    internal sealed record ReadFrom(string? Binary, RecordStamps? Stamps, string? Ambiguity = null);

    public IReadOnlyList<PluginAddress> Keys
    {
        get { lock (_lock) return [.. _failed.Keys]; }
    }

    /// <summary>While what it reads from is unchanged the error state stands, and the parse is not
    /// paid again.</summary>
    public bool StillFailing(RegisteredPlugin plugin)
    {
        ReadFrom? failedAt;
        lock (_lock)
        {
            if (!_failed.TryGetValue(plugin.Key, out failedAt)) return false;
        }
        return failedAt is not null && StateOf(plugin) is { } now && failedAt == now;
    }

    /// <summary>Taken before a read, as a file can change after it. Null, which vouches for nothing,
    /// when what the plugin reads from cannot be read: an untracked binary, or a tree with an
    /// unreadable document.</summary>
    public ReadFrom? StateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        if (Projector.TreeModOf(plugin.Key, plugin.Provider) is not { } mod)
            return binary is null ? null : new ReadFrom(binary, null);

        if (!Projector.TryTreeStamps(mod, index.Release, plugin.Key, out var stamps, out var ambiguity))
            return new ReadFrom(binary, null, ambiguity);
        return stamps.Unreadable.Count == 0 ? new ReadFrom(binary, stamps) : null;
    }

    public void Remember(PluginAddress key, ReadFrom? readFrom)
    {
        lock (_lock) _failed[key] = readFrom;
    }

    /// <summary>Remembers a failure that vouches for nothing: a file another process held is read
    /// again at the next snapshot, whatever it reads from.</summary>
    public void RememberUntilTheNextSnapshot(PluginAddress key) => Remember(key, null);

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }
}
