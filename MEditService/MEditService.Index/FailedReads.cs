using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index)
{
    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, ReadState?> _failed = new(PluginAddress.Comparer);

    public IReadOnlyList<PluginAddress> Keys
    {
        get { lock (_lock) return [.. _failed.Keys]; }
    }

    /// <summary>While what it reads from is unchanged the error state stands, and the parse is not
    /// paid again.</summary>
    public bool StillFailing(RegisteredPlugin plugin)
    {
        ReadState? failedAt;
        lock (_lock)
        {
            if (!_failed.TryGetValue(plugin.Key, out failedAt)) return false;
        }
        return failedAt is not null && failedAt == ReadStateOf(plugin);
    }

    /// <summary>Runs one read of <paramref name="plugin"/> over what it reads from, taken first, as a
    /// file can change during the read. A failure is remembered against that state, unless a file
    /// another process held stopped it.</summary>
    public void Read(RegisteredPlugin plugin, Func<ReadState, bool> read)
    {
        ReadState? state = null;
        try
        {
            state = ReadStateOf(plugin);
            if (read(state)) Forget(plugin.Key);
            else Remember(plugin.Key, state);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            Remember(plugin.Key, ex is IOException or UnauthorizedAccessException ? null : state);
            throw;
        }
    }

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }

    private void Remember(PluginAddress key, ReadState? state)
    {
        lock (_lock) _failed[key] = state is { Vouches: true } ? state : null;
    }

    private ReadState ReadStateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        if (Projector.TreeModOf(plugin.Key, plugin.Provider) is not { } mod) return new ReadState(binary, null, null);

        return Projector.TryTreeStamps(mod, index.Release, plugin.Key, out var stamps, out var ambiguity)
            ? new ReadState(binary, stamps, null)
            : new ReadState(binary, null, ambiguity);
    }
}
