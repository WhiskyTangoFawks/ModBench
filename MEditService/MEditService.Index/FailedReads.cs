using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index, ISourceAdapter source)
{
    private sealed record Failure(ReadState? ReadFrom, bool Stands, IReadOnlyList<SourceFileFailure> Files);

    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, Failure> _failed = new(PluginAddress.Comparer);

    public IReadOnlyList<PluginAddress> Keys
    {
        get { lock (_lock) return [.. _failed.Keys]; }
    }

    public IReadOnlyList<SourceFileFailure> SourceFileFailures
    {
        get { lock (_lock) return [.. _failed.Values.SelectMany(failure => failure.Files)]; }
    }

    public bool Holds(PluginAddress key)
    {
        lock (_lock) return _failed.ContainsKey(key);
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
    /// file can change during the read. A failure is remembered against that state with the files
    /// that stopped it.</summary>
    public void Read(RegisteredPlugin plugin, Func<ReadState, ReadOutcome> read)
    {
        ReadState? state = null;
        try
        {
            state = ReadStateOf(plugin);
            var outcome = read(state);
            if (outcome.Served) Forget(plugin.Key);
            else Remember(plugin.Key, state, state.Vouches && StateObserves(outcome.StoppedBy), outcome.StoppedBy);
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // Only the binary's read throws, and its hash observes what stopped it, unless another
            // process held the file.
            Remember(plugin.Key, state, state is { Vouches: true } && ex is not (IOException or UnauthorizedAccessException), ex);
            throw;
        }
    }

    // A tree that stopped the read stands only on its documents, whose stamps the state holds. The state
    // holds nothing of git or of a file another process held, so those are read again at the next reconcile.
    private static bool StateObserves(Exception? stoppedBy) =>
        stoppedBy is null or UnreadableSourceDocumentException or AmbiguousSourceUnitException;

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }

    private void Remember(PluginAddress key, ReadState? state, bool stands, Exception? stoppedBy)
    {
        IReadOnlyList<SourceFileFailure> files =
        [
            .. (state?.FileFailuresOf(key) ?? []).Concat(SourceFileFailure.Of(key, stoppedBy))
                .DistinctBy(file => (file.SourceRelativePath, file.FormKey)),
        ];
        lock (_lock) _failed[key] = new Failure(state, stands, files);
    }

    private ReadState ReadStateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        return new ReadState(binary, source.TreeOf(plugin, index.Release)?.StampsOf(plugin.Key));
    }
}
