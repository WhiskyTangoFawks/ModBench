using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index)
{
    private sealed record Failure(ReadState? ReadFrom, bool Stands);

    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, Failure> _failed = new(PluginAddress.Comparer);

    public IReadOnlyList<PluginAddress> Keys
    {
        get { lock (_lock) return [.. _failed.Keys]; }
    }

    public IReadOnlyList<SourceFileFailure> SourceFileFailures
    {
        get
        {
            lock (_lock)
                return [.. _failed.SelectMany(failed => failed.Value.ReadFrom?.FileFailuresOf(failed.Key) ?? [])];
        }
    }

    /// <summary>While what it reads from is unchanged the error state stands, and the parse is not
    /// paid again.</summary>
    public bool StillFailing(RegisteredPlugin plugin)
    {
        Failure? failure;
        lock (_lock)
        {
            if (!_failed.TryGetValue(plugin.Key, out failure)) return false;
        }
        return failure.Stands && failure.ReadFrom == ReadStateOf(plugin);
    }

    /// <summary>Runs one read of <paramref name="plugin"/> over what it reads from, taken first, as a
    /// file can change during the read. A failure is remembered against that state, and stands unless
    /// a file could not be read.</summary>
    public void Read(RegisteredPlugin plugin, Func<ReadState, bool> read)
    {
        ReadState? state = null;
        try
        {
            state = ReadStateOf(plugin);
            if (read(state)) Forget(plugin.Key);
            else Remember(plugin.Key, state, stands: state.Vouches);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            Remember(plugin.Key, state, stands: state is { Vouches: true } && ex is not (IOException or UnauthorizedAccessException));
            throw;
        }
    }

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }

    private void Remember(PluginAddress key, ReadState? state, bool stands)
    {
        lock (_lock) _failed[key] = new Failure(state, stands);
    }

    private ReadState ReadStateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        return Projector.TreeModOf(plugin.Key, plugin.Provider) is { } mod
            ? new ReadState(binary, SourceRepository.Over(mod, index.Release).StampsOf(plugin.Key))
            : new ReadState(binary, null);
    }
}
