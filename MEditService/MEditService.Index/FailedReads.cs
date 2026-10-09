using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;

namespace MEditService.Index;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(DuckDbRecordIndex index, ISourceAdapter source)
{
    private sealed record Failure(ReadState? ReadFrom, bool Stands, IReadOnlyList<SourceFileFailure> Files, UnreadableSource? Why);

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

    /// <summary>What stopped the plugin's tree in its last failed read, while it fails.</summary>
    public UnreadableSource? WhyTreeStopped(PluginAddress key)
    {
        lock (_lock) return _failed.TryGetValue(key, out var failure) ? failure.Why : null;
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
    public ReadOutcome Read(RegisteredPlugin plugin, Func<ReadState, ReadOutcome> read)
    {
        ReadState? state = null;
        try
        {
            state = ReadStateOf(plugin);
            var outcome = read(state);
            if (outcome.Served) Forget(plugin.Key);
            else Remember(plugin.Key, state, state.Vouches && StateObserves(outcome), outcome.TreeStopped, WhyStopped(outcome));
            return outcome;
        }
        catch (Exception ex) when (ex is not (OperationCanceledException or OutOfMemoryException))
        {
            // A plugin file's own failure is an answer, so a throw is the store's or the tree's, and
            // nothing the state holds observes it.
            Remember(plugin.Key, state, stands: false, treeStopped: null, why: null);
            throw;
        }
    }

    // A stopped read stands on what the state holds: a tree's document stamps, a binary's hash. It
    // holds nothing of git or of a file another process held, so those are read again at the next
    // reconcile.
    private static bool StateObserves(ReadOutcome outcome) =>
        outcome is { Failure: not PluginFailure.Inaccessible, StoppedBy: null, TreeStopped: null or SourceFailure.Unreadable or SourceFailure.Ambiguous };

    private static UnreadableSource? WhyStopped(ReadOutcome outcome)
    {
        if (outcome.TreeStopped is { } failure) return UnreadableSource.Of(failure);
        return outcome.StoppedBy is { } error ? UnreadableSource.Of(error) : null;
    }

    public void Forget(PluginAddress key)
    {
        lock (_lock) _failed.Remove(key);
    }

    private void Remember(PluginAddress key, ReadState? state, bool stands, SourceFailure? treeStopped, UnreadableSource? why)
    {
        IReadOnlyList<SourceFileFailure> files =
        [
            .. (state?.FileFailuresOf(key) ?? []).Concat(SourceFileFailure.Of(key, treeStopped))
                .DistinctBy(file => (file.SourceRelativePath, file.FormKey)),
        ];
        lock (_lock) _failed[key] = new Failure(state, stands, files, why);
    }

    private ReadState ReadStateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        return new ReadState(binary, source.TreeOf(plugin, index.Release)?.StampsOf(plugin.Key));
    }
}
