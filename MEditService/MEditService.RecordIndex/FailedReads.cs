using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.RecordIndex;

/// <summary>A plugin that failed to read stays in its error state (ADR-0013) until what it reads
/// from changes, which the state taken before the read detects.</summary>
internal sealed class FailedReads(Store index, ISourceAdapter source, ILogger logger)
{
    // RowsStand: unsaved text alone stopped the read, so the rows are the last good read's (common.md,
    // States, story 6), and the next good read clears it.
    private sealed record Failure(
        ReadState? ReadFrom, bool Stands, IReadOnlyList<SourceFileFailure> Files, UnreadableSource? Why, bool RowsStand = false);

    private readonly Lock _lock = new();
    private readonly Dictionary<PluginAddress, Failure> _failed = new(PluginAddress.Comparer);
    private readonly Dictionary<PluginAddress, IReadOnlyList<FileProblem>> _problems = new(PluginAddress.Comparer);

    /// <summary>What the last read of each plugin found wrong in files it still read.</summary>
    public IReadOnlyList<(PluginAddress Plugin, FileProblem Problem)> FileProblems
    {
        get { lock (_lock) return [.. _problems.SelectMany(held => held.Value.Select(problem => (held.Key, problem)))]; }
    }

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

    public IReadOnlyList<SourceFileFailure>? LaterReadFailure(PluginAddress key)
    {
        lock (_lock) return LaterReadFailureOf(_failed.GetValueOrDefault(key));
    }

    /// <summary>Whether the plugin's rows are what a failed read left, which say nothing of what it
    /// reads from now.</summary>
    public bool Holds(PluginAddress key)
    {
        lock (_lock) return _failed.TryGetValue(key, out var failure) && !failure.RowsStand;
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
            Settle(plugin.Key, FailureAfter(plugin.Key, state, outcome));
            NoteProblems(plugin.Key, state.Stamps?.Problems ?? []);
            return outcome;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // A plugin file's own failure is an answer, so a throw is the store's, the tree's, or the
            // memory's.
            Settle(plugin.Key, FailureOf(plugin.Key, state, state is not null && StandsOn(state, ReadOutcome.StoppedAt(ex)), treeStopped: null, why: null));
            throw;
        }
    }

    private static Failure? FailureAfter(PluginAddress key, ReadState state, ReadOutcome outcome)
    {
        if (!outcome.Served) return FailureOf(key, state, StandsOn(state, outcome), outcome.TreeStopped, WhyStopped(outcome));
        return state.Stamps is { StoppedOnlyByUnsavedText: true } ? RowsStandOver(key, state) : null;
    }

    // A read that ran out of memory stands on a state that does not vouch: a file it could not read did
    // not run it out.
    private static bool StandsOn(ReadState state, ReadOutcome outcome) =>
        outcome.StoppedBy is OutOfMemoryException || (state.Vouches && StateObserves(outcome));

    // A stopped read stands on what the state holds: a tree's document stamps, a binary's hash. A
    // failure of git, or not of the plugin's bytes, is read again at the next reconcile.
    private static bool StateObserves(ReadOutcome outcome) =>
        outcome is { Failure: null or { OfItsBytes: true }, StoppedBy: null, TreeStopped: null or SourceFailure.Unreadable or SourceFailure.Ambiguous };

    private static UnreadableSource? WhyStopped(ReadOutcome outcome)
    {
        if (outcome.TreeStopped is { } failure) return UnreadableSources.Of(failure);
        return outcome.StoppedBy is { } error ? UnreadableSources.Of(error) : null;
    }

    public void Forget(PluginAddress key)
    {
        lock (_lock)
        {
            _failed.Remove(key);
            _problems.Remove(key);
        }
    }

    // The views read the problems again as they change, which no row announces.
    private void NoteProblems(PluginAddress key, IReadOnlyList<FileProblem> found)
    {
        lock (_lock)
        {
            var before = _problems.GetValueOrDefault(key) ?? [];
            if (before.SequenceEqual(found)) return;
            if (found.Count == 0) _problems.Remove(key);
            else _problems[key] = found;
        }
        index.Commit(projection => projection.ReadFailedOrRecovered(key));
    }

    // The views read a later read's failure again as it begins, changes and clears; the Output gets
    // one line as it begins.
    private void Settle(PluginAddress key, Failure? next)
    {
        Failure? before;
        lock (_lock)
        {
            before = _failed.GetValueOrDefault(key);
            if (next is null) _failed.Remove(key);
            else _failed[key] = next;
        }

        var (was, now) = (LaterReadFailureOf(before), LaterReadFailureOf(next));
        if (was is null ? now is null : now is not null && was.SequenceEqual(now)) return;
        if (was is null && now is not null && logger.IsEnabled(LogLevel.Warning))
        {
            logger.LogWarning(
                "Could not read {Plugin} ({Origin}), so it shows the last good read: {Reason}",
                key.Name, key.Origin, string.Join(" ", now.Select(file => file.Message)));
        }
        index.Commit(projection => projection.ReadFailedOrRecovered(key));
    }

    private static IReadOnlyList<SourceFileFailure>? LaterReadFailureOf(Failure? failure) =>
        failure is { RowsStand: true } ? failure.Files : null;

    private static Failure RowsStandOver(PluginAddress key, ReadState state) =>
        new(state, Stands: false, FilesOf(key, state, treeStopped: null), Why: null, RowsStand: true);

    private static Failure FailureOf(PluginAddress key, ReadState? state, bool stands, SourceFailure? treeStopped, UnreadableSource? why) =>
        new(state, stands, FilesOf(key, state, treeStopped), why);

    private static IReadOnlyList<SourceFileFailure> FilesOf(PluginAddress key, ReadState? state, SourceFailure? treeStopped) =>
    [
        .. (state?.FileFailuresOf(key) ?? []).Concat(SourceFileFailure.Of(key, treeStopped))
            .DistinctBy(file => (file.SourceRelativePath, file.FormKey)),
    ];

    private ReadState ReadStateOf(RegisteredPlugin plugin)
    {
        var binary = index.FileContentHash(plugin.Path);
        return new ReadState(binary, source.TreeOf(plugin, index.Release)?.StampsOf(plugin.Key));
    }
}
