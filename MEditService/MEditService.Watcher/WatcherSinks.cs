using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;

namespace MEditService.Watcher;

/// <summary>Where a settle lands: the Index's source projection, binary refresh and reconcile, and
/// Commands' "a tracked mod settled". Each sink logs its own failure, since a timer thread has no
/// caller to propagate to (ADR-0019).</summary>
internal sealed class WatcherSinks
{
    private readonly IRefreshIndex _index;
    private readonly TrackedModSettled _settled;
    private readonly ILogger _logger;

    public WatcherSinks(IRefreshIndex index, TrackedModSettled settled, ILogger logger)
    {
        _index = index;
        _settled = settled;
        _logger = logger;
    }

    /// <summary>ADR-0013 invariant 1: the one reconcile per load-order change, on the caller's
    /// thread.</summary>
    public void Reconcile(LoadOrderSnapshot snapshot, long version) => _index.Reconcile(snapshot, version);

    /// <summary>"A tracked mod settled" (ADR-0015 invariant 2) at load, over the bytes the
    /// readability probe already read. Logging only: whichever question or offer Commands found, it
    /// already published.</summary>
    public void SettleAtLoad(
        LoadOrderSnapshot order, string modFolder, IReadOnlyList<(string PluginName, byte[] ObservedBytes)> plugins)
    {
        switch (_settled.Handle(order, modFolder, plugins))
        {
            case TrackedModSettledOutcome.QuestionOpened:
                if (_logger.IsEnabled(LogLevel.Information))
                    _logger.LogInformation("External change detected at load for {ModFolder}", modFolder);
                break;

            case TrackedModSettledOutcome.CrashRecovery:
                if (_logger.IsEnabled(LogLevel.Information))
                    _logger.LogInformation("Interrupted compile detected at load for {ModFolder}", modFolder);
                break;
        }
    }

    /// <summary>The same verb for a live settle, where Commands reads the mod's binaries itself: a
    /// plugin caught mid-write is no verdict.</summary>
    public void Settle(LoadOrderSnapshot order, string modFolder) => _settled.Handle(order, modFolder);

    /// <summary>A tracked binary the load-time probe could not read: a repair offer, never Commands'
    /// own external-change question.</summary>
    public void OfferRepairForUnreadable(LoadOrderSnapshot order, string modFolder, string pluginName) =>
        _settled.RaiseCrashRepair(order, modFolder, [pluginName], CrashRepairReason.MissingOrUnreadableBinary);

    /// <summary>ADR-0009's runtime half: key and path only, never a locally remembered hash. The
    /// Index owns the comparison and announces whatever landed.</summary>
    public async Task RefreshBinary(PluginCopyKey key, string path)
    {
        try
        {
            await _index.RefreshBinary(key, path).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogWarning(ex,
                "Could not project the on-disk change to {Plugin} ({Origin}) into the index; it will be retried " +
                "the next time that file settles, and re-checked at the next reconcile", key.Name, key.Origin);
        }
    }

    /// <summary>ADR-0015 invariant 2: everything one mod settled together, under one gate
    /// acquisition and one projection scope, so a client that awaits once sees the whole
    /// batch.</summary>
    public void ProjectSourceBatch(IReadOnlyList<SourceChangeEvent> batch)
    {
        // A closed Index has nowhere for a batch to land, and the next reconcile re-derives whatever
        // settled while it was shut.
        if (_index.Closed) return;

        try
        {
            using var _ = _index.WriteGate.Enter();
            using var projection = _index.BeginProjection();
            foreach (var change in batch) ProjectOne(change);
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // ADR-0019: never swallowed; logged whole rather than lost, and re-checked the same
            // way a single plugin's own catch below re-checks its.
            var plugins = string.Join(", ", batch.Select(c => $"{c.PluginName} ({c.Origin})"));
            _logger.LogWarning(ex,
                "Could not project the source change batch for {Plugins}; it will be re-checked at the " +
                "next signal and at the next reconcile", plugins);
        }
    }

    private void ProjectOne(SourceChangeEvent change)
    {
        var key = new PluginCopyKey(change.PluginName, change.Origin);
        try
        {
            // A mod with no repository is untracked rather than broken: nothing to project from.
            if (!SourceRepository.IsTracked(change.ModFolder)) return;

            if (change.Scope == SourceChangeScope.Documents && FormKeysOf(change) is { } formKeys)
            {
                _index.RefreshKeys(key, formKeys);
                return;
            }

            ValidateWholeCopy(key, "a source change");
        }
        catch (Exception ex) when (ex is not OutOfMemoryException)
        {
            _logger.LogWarning(ex,
                "Could not project the source change to {Plugin} ({Origin}); it will be re-checked at the " +
                "next signal and at the next reconcile", change.PluginName, change.Origin);
        }
    }

    /// <summary>ADR-0015 invariant 4: one git listing for the whole copy, compared by content hash.
    /// The Index announces a copy it re-derives.</summary>
    public void ValidateWholeCopy(PluginCopyKey key, string reason)
    {
        foreach (var report in _index.ValidateIndex(key))
        {
            foreach (var failure in report.Failures)
                _logger.LogWarning("Validating {Plugin} after {Reason}: {Failure}", key.Name, reason, failure);
        }
    }

    // A file declaring nothing, deleted or unreadable, is named by HEAD's document at its path. Null
    // when neither names a key, or another path in the batch declares the key HEAD named: a
    // rename, which only a whole-copy validate keys right.
    private static List<string>? FormKeysOf(SourceChangeEvent change)
    {
        var declared = new List<string>();
        var namedByHead = new List<string>();
        foreach (var path in change.Paths)
        {
            if (SourceRepository.CarriesNoRecord(path)) continue;
            if (SourceRepository.FormKeyDeclaredBy(path, change.PluginName) is { } formKey)
                declared.Add(formKey);
            else if (SourceRepository.FormKeyCommittedAt(change.ModFolder, path, change.PluginName) is { } committed)
                namedByHead.Add(committed);
            else
                return null;
        }

        if (namedByHead.Intersect(declared, StringComparer.Ordinal).Any()) return null;
        return [.. declared, .. namedByHead];
    }
}
