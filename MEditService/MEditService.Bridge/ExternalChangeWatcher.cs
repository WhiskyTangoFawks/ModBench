using System.Timers;
using MEditService.Core.Source;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>The live-watch half of external-change detection: only the watch lifecycle and the
/// unanswered-question queue live here. Classification, self-echo and crash-marker suppression are
/// Core's, shared with the load-time hash check.</summary>
public sealed class ExternalChangeWatcher : IDisposable
{
    private readonly TimeSpan _debounce;
    private readonly object _gate = new();
    private readonly Dictionary<string, WatchEntry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, UnansweredExternalChange> _unanswered = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MirrorEntry> _mirrors = new(StringComparer.Ordinal);

    /// <param name="debounce">Collapses the several write events one plugin save raises into a single
    /// classification. Defaults to 300ms; tests shorten it.</param>
    public ExternalChangeWatcher(TimeSpan? debounce = null)
    {
        _debounce = debounce ?? TimeSpan.FromMilliseconds(300);
    }

    /// <summary>Re-watching an already-watched (modFolder, plugin) pair replaces the previous watch;
    /// the composition root re-registers on every reconcile.</summary>
    public void Watch(string modFolder, string pluginName, string pluginPath)
    {
        var key = Key(modFolder, pluginName);
        var directory = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var existing)) existing.Dispose();
            _entries[key] = StartWatch(directory, pluginPath, () => Settle(modFolder, pluginName, pluginPath),
                () => WatchOverflowed?.Invoke(modFolder, pluginName));
        }
    }

    /// <summary>ADR-0046 invariant 6: an OS overflow drops events, so nothing this classification
    /// watch saw can be trusted. modFolder/pluginName — this watcher's bare identity, not a
    /// PluginKey.</summary>
    public Action<string, string>? WatchOverflowed { get; set; }

    /// <summary>The mirror-watch counterpart: <see cref="WatchIndexed"/> already carries an origin.</summary>
    public Action<string, string>? IndexedWatchOverflowed { get; set; }

    private WatchEntry StartWatch(string directory, string pluginPath, Action onSettle, Action onOverflow)
    {
        var fsWatcher = new FileSystemWatcher(directory, Path.GetFileName(pluginPath))
        {
            // FileName is required for Renamed to fire: a temp-file-then-rename write raises neither
            // Changed nor Created, and .NET's inotify-backed Linux watcher gates Renamed on this bit.
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
            // Wider than the 8KB default: Error is still the backstop when a burst outruns even this.
            InternalBufferSize = 65536,
        };
        var debounceTimer = new Timer(_debounce.TotalMilliseconds) { AutoReset = false };
        debounceTimer.Elapsed += (_, _) => onSettle();
        fsWatcher.Changed += (_, _) => Restart(debounceTimer);
        fsWatcher.Created += (_, _) => Restart(debounceTimer);
        fsWatcher.Renamed += (_, _) => Restart(debounceTimer);
        // A deletion is a settle like any other: the whole point of a mirror watch, and a no-op for
        // a classification watch, whose Settle finds no bytes and returns.
        fsWatcher.Deleted += (_, _) => Restart(debounceTimer);
        fsWatcher.Error += (_, _) => RaiseSafely(onOverflow);
        fsWatcher.EnableRaisingEvents = true;
        return new WatchEntry(fsWatcher, debounceTimer);
    }

    // Runs on the FileSystemWatcher's own error-reporting thread, with no caller to catch anything.
    private static void RaiseSafely(Action action)
    {
        try
        {
            action();
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(ex);
        }
    }

    /// <summary>ADR-0001. A delegate, not an event, because the handler answers whether it applied:
    /// a false answer puts the remembered hash back so the next settle retries. Raised outside the
    /// lock, since the handler re-indexes a plugin.</summary>
    public Func<IndexedBinaryEvent, bool>? IndexedBinaryChanged { get; set; }

    /// <summary>ADR-0001: mirrors one indexed binary into the index with no reload.
    /// <paramref name="contentHash"/> is what the rows were built from, so a settle hashing to the
    /// same bytes raises nothing: a touch is free.</summary>
    public void WatchIndexed(string pluginName, string origin, string pluginPath, string contentHash)
    {
        var directory = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            var key = MirrorKey(origin, pluginName);
            if (_mirrors.TryGetValue(key, out var existing)) existing.Dispose();
            var mirror = new MirrorEntry(contentHash, pluginPath)
            {
                Watch = StartWatch(directory, pluginPath, () => SettleIndexed(pluginName, origin, pluginPath),
                    () => IndexedWatchOverflowed?.Invoke(pluginName, origin)),
            };
            _mirrors[key] = mirror;
        }
    }

    /// <summary>Called before re-registering a freshly loaded load order's plugins, so a watch never
    /// outlives the load order that asked for it and re-indexes a plugin it does not hold.</summary>
    public void UnwatchAllIndexed()
    {
        lock (_gate)
        {
            foreach (var mirror in _mirrors.Values) mirror.Dispose();
            _mirrors.Clear();
        }
    }

    /// <summary>Never <see cref="ExternalChangeClassification.SelfEcho"/> or CrashRecovery, which are
    /// filtered before a question is queued. One entry per plugin: a second detection replaces the
    /// queued question rather than duplicating it.</summary>
    public IReadOnlyList<UnansweredExternalChange> Unanswered()
    {
        lock (_gate) return [.. _unanswered.Values];
    }

    /// <summary>Drops a plugin's queued question once answered, so a stale question never re-surfaces
    /// after being resolved through another path such as the load-time check.</summary>
    public void MarkAnswered(string modFolder, string pluginName)
    {
        lock (_gate) _unanswered.Remove(Key(modFolder, pluginName));
    }

    /// <summary>ADR-0046: raised once the question is queued, whichever trigger found it. A
    /// delegate, not an event, matching the watcher's other single-subscriber signals; raised
    /// outside the lock, since the handler publishes a notification.</summary>
    public Action<UnansweredExternalChange>? ExternalChangeReported { get; set; }

    /// <summary>Both triggers get <see cref="ExternalChangeDeferral"/>'s marker here. Set inside the
    /// lock, before the queue: the lock's barrier makes the refusal visible to another thread the
    /// instant the question is, and serializes the marker writes.</summary>
    public void ReportExternalChange(string modFolder, string pluginName, ExternalChangeClassification.ExternalChange classification)
    {
        UnansweredExternalChange change;
        lock (_gate)
        {
            ExternalChangeDeferral.Set(modFolder, pluginName,
                $"{pluginName} (in {Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar))}) changed outside " +
                "Modbench and is awaiting an answer — Absorb Upstream Update or Keep as My Edit.");
            change = new UnansweredExternalChange(modFolder, pluginName, classification);
            _unanswered[Key(modFolder, pluginName)] = change;
        }
        RaiseSafely(() => ExternalChangeReported?.Invoke(change));
    }

    private static void Restart(Timer debounceTimer)
    {
        debounceTimer.Stop();
        debounceTimer.Start();
    }

    private void Settle(string modFolder, string pluginName, string pluginPath)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(pluginPath);
        }
        catch (IOException)
        {
            // Caught mid-write by a process still holding the file; nothing further to wait for
            // here, and the load-time hash check is the backstop if this event is missed.
            return;
        }

        var classification = ExternalChangeClassifier.Classify(modFolder, pluginName, bytes);
        if (classification is ExternalChangeClassification.ExternalChange externalChange)
            ReportExternalChange(modFolder, pluginName, externalChange);
    }

    // Identical bytes raise nothing, so a touch costs no re-index. The remembered hash moves ahead
    // of the handler and is put back on failure only if nothing newer has landed.
    private void SettleIndexed(string pluginName, string origin, string pluginPath)
    {
        var key = MirrorKey(origin, pluginName);
        IndexedBinaryEvent notification;
        string? previousHash;
        string? reportedHash;
        lock (_gate)
        {
            // A superseded watch's settle names the key its successor now holds at another path.
            if (!_mirrors.TryGetValue(key, out var mirror) || mirror.PluginPath != pluginPath) return;
            previousHash = mirror.ContentHash;

            if (!File.Exists(pluginPath))
            {
                // Already reported gone: a delete raises several events and the file stays absent,
                // so without this every one of them would remove the same rows again.
                if (previousHash == null) return;
                reportedHash = null;
                notification = new IndexedBinaryEvent(pluginName, origin, pluginPath, IndexedBinaryChange.Deleted);
            }
            else
            {
                // Unreadable is not "changed": a file another process is still writing says nothing
                // about whether the indexed rows are stale, and the next event settles it.
                if (PluginBinaryHash.OfFile(pluginPath) is not { } observed || observed == previousHash) return;
                reportedHash = observed;
                notification = new IndexedBinaryEvent(pluginName, origin, pluginPath, IndexedBinaryChange.Modified);
            }

            mirror.ContentHash = reportedHash;
        }

        bool applied;
        try
        {
            // No handler at all means nothing is out of step with this file, so there is nothing to
            // retry — only a handler that ran and failed leaves the index behind the disk.
            applied = IndexedBinaryChanged?.Invoke(notification) ?? true;
        }
        catch
        {
            // The subscriber is expected to answer rather than throw, but this runs on a timer
            // callback with no caller to catch anything: an escaping exception here
            // would take the process down over one file event.
            applied = false;
        }

        if (applied) return;

        lock (_gate)
        {
            if (_mirrors.TryGetValue(key, out var mirror) && mirror.ContentHash == reportedHash)
                mirror.ContentHash = previousHash;
        }
    }

    private static string Key(string modFolder, string pluginName) =>
        $"{modFolder} {pluginName}";

    // (origin, plugin) — the compound plugin identity, not a mod folder: an index-mirror watch
    // covers plugins that have no mod folder at all, the game's own Data/ masters above all.
    private static string MirrorKey(string origin, string pluginName) =>
        string.Concat(origin, "\u0000", pluginName);

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var entry in _entries.Values) entry.Dispose();
            _entries.Clear();
            foreach (var mirror in _mirrors.Values) mirror.Dispose();
            _mirrors.Clear();
        }
    }

    private sealed class WatchEntry(FileSystemWatcher watcher, Timer debounceTimer) : IDisposable
    {
        public void Dispose()
        {
            watcher.Dispose();
            debounceTimer.Dispose();
        }
    }

    // ContentHash is null once the file's disappearance has been reported. Guarded by _gate.
    private sealed class MirrorEntry(string contentHash, string pluginPath) : IDisposable
    {
        public string? ContentHash { get; set; } = contentHash;
        public string PluginPath { get; } = pluginPath;
        public WatchEntry? Watch { get; init; }
        public void Dispose() => Watch?.Dispose();
    }
}

public enum IndexedBinaryChange
{
    Modified,
    Deleted,
}

/// <summary>ADR-0001: one indexed binary's disk event. A bare (name, origin) pair rather than a
/// PluginKey: this assembly may not reference the load order or record-index namespaces.</summary>
public sealed record IndexedBinaryEvent(string PluginName, string Origin, string PluginPath, IndexedBinaryChange Change);

/// <summary>One plugin's unanswered external-change question, as the watcher (or the load-time
/// check, via the same classification) last observed it — what
/// <c>GET /plugins/external-changes/status</c> hands the extension to drive the one dialog.</summary>
public sealed record UnansweredExternalChange(string ModFolder, string PluginName, ExternalChangeClassification.ExternalChange Classification);
