using System.Timers;
using MEditService.Core.Source;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>
/// External-change detection's live-watch half: a <see cref="FileSystemWatcher"/> per watched (mod folder, plugin) pair,
/// debounced, calling straight into <see cref="ExternalChangeClassifier"/> — the only mechanic this
/// class owns is the watch lifecycle and the unanswered-question queue; classification, self-echo
/// suppression and crash-marker suppression all live in <c>MEditService.Core.Source</c>, exactly as
/// the load-time hash check (a different caller entirely, wired from <c>MEditService.Api</c>) also
/// calls it. See this project's own <c>.csproj</c> description for the boundary this keeps.
/// </summary>
public sealed class ExternalChangeWatcher : IDisposable
{
    private readonly TimeSpan _debounce;
    private readonly object _gate = new();
    private readonly Dictionary<string, WatchEntry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, UnansweredExternalChange> _unanswered = new(StringComparer.Ordinal);
    private readonly Dictionary<string, MirrorEntry> _mirrors = new(StringComparer.Ordinal);

    /// <param name="debounce">How long to wait after the last file-system event before reading and
    /// classifying the binary — collapses the several write events one plugin save can raise (xEdit,
    /// like most writers, does not always touch a file exactly once) into a single classification.
    /// Defaults to 300ms; tests override it to keep the suite fast.</param>
    public ExternalChangeWatcher(TimeSpan? debounce = null)
    {
        _debounce = debounce ?? TimeSpan.FromMilliseconds(300);
    }

    /// <summary>Starts watching one tracked plugin's binary for out-of-band writes. Re-watching an
    /// already-watched (modFolder, plugin) pair replaces the previous watch — the composition root
    /// (<c>MEditService.Api</c>) re-registers on every reconcile, for every plugin the load order
    /// currently tracks.</summary>
    public void Watch(string modFolder, string pluginName, string pluginPath)
    {
        var key = Key(modFolder, pluginName);
        var directory = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            if (_entries.TryGetValue(key, out var existing)) existing.Dispose();
            _entries[key] = StartWatch(directory, pluginPath, () => Settle(modFolder, pluginName, pluginPath));
        }
    }

    /// <summary>The watch mechanic itself, shared by both kinds of watch this class keeps: a
    /// <see cref="FileSystemWatcher"/> on one file, every event restarting one debounce timer, and
    /// <paramref name="onSettle"/> run once the writes stop. What a settle then <i>means</i> is the
    /// caller's — a question for the user (<see cref="Settle"/>) or a re-index
    /// (<see cref="SettleIndexed"/>).</summary>
    private WatchEntry StartWatch(string directory, string pluginPath, Action onSettle)
    {
        var fsWatcher = new FileSystemWatcher(directory, Path.GetFileName(pluginPath))
        {
            // FileName is required for Renamed to fire at all (confirmed empirically, not
            // assumed): a temp-file-then-rename commit — exactly how PluginWriter.Commit()
            // writes every binary, Save & Compile included — raises neither Changed nor
            // Created without it; .NET's Linux FileSystemWatcher (inotify-backed) gates the
            // Renamed event on this bit. Without it, the live watcher could not see Save &
            // Compile's own writes at all, by any event, which would have made self-echo
            // suppression untestable through this class (and the production watcher blind to
            // its own writes) rather than merely untested.
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
        };
        var debounceTimer = new Timer(_debounce.TotalMilliseconds) { AutoReset = false };
        debounceTimer.Elapsed += (_, _) => onSettle();
        fsWatcher.Changed += (_, _) => Restart(debounceTimer);
        fsWatcher.Created += (_, _) => Restart(debounceTimer);
        // A rename *into* the watched filename (PluginWriter.Commit()'s File.Move(tmpPath,
        // finalPath), the shape every production binary write actually takes) surfaces here,
        // never as Changed/Created — see the NotifyFilter comment above.
        fsWatcher.Renamed += (_, _) => Restart(debounceTimer);
        // A deletion is a settle like any other. It is the whole point of a mirror watch (the
        // rows go), and a no-op for a classification watch, whose Settle finds no bytes to read and
        // returns — the load-time check is what reports a tracked plugin's missing binary.
        fsWatcher.Deleted += (_, _) => Restart(debounceTimer);
        fsWatcher.EnableRaisingEvents = true;
        return new WatchEntry(fsWatcher, debounceTimer);
    }

    /// <summary>
    /// ADR-0001: one indexed binary changed or vanished on disk while a load order is live.
    /// Raised only for the plugins watched through <see cref="WatchIndexed"/> — the ones whose rows
    /// come from the binary — never for a tracked plugin, whose out-of-band writes are a question
    /// for the user (Absorb / Keep) rather than a silent re-index.
    ///
    /// <para>Raised <i>outside</i> this class's lock, on the debounce timer's thread: the handler
    /// re-indexes a whole plugin, and holding the watch lock across that would stall every other
    /// watch's settle behind it.</para>
    ///
    /// <para><b>The handler answers whether it applied the change</b>, which is why this is a
    /// delegate rather than an event. This class remembers what it last told anyone about a file so
    /// that the several events one write raises report it once; if the handler could not act — the
    /// load order torn down mid-settle, the file still held by the writer — remembering the new bytes
    /// anyway would leave the index holding rows nothing on disk backs, silently, until the next
    /// load. So a false answer puts the remembered hash back and the next settle retries. One
    /// subscriber by construction (the composition root), which is also what makes a return value
    /// meaningful here.</para>
    /// </summary>
    public Func<IndexedBinaryEvent, bool>? IndexedBinaryChanged { get; set; }

    /// <summary>
    /// ADR-0001: starts mirroring one <b>indexed</b> binary — the game's <c>Data/</c>
    /// included — so a write by MO2, xEdit, Steam or the user reaches the index with no reload.
    /// <paramref name="contentHash"/> is what the index's rows were built from, and is what makes a
    /// <i>touch</i> free: a settle that hashes to the same bytes raises nothing at all. Re-watching
    /// an (origin, plugin) pair replaces the previous watch and its remembered hash.
    /// </summary>
    public void WatchIndexed(string pluginName, string origin, string pluginPath, string contentHash)
    {
        var directory = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            var key = MirrorKey(origin, pluginName);
            if (_mirrors.TryGetValue(key, out var existing)) existing.Dispose();
            var mirror = new MirrorEntry(contentHash)
            {
                Watch = StartWatch(directory, pluginPath, () => SettleIndexed(pluginName, origin, pluginPath)),
            };
            _mirrors[key] = mirror;
        }
    }

    /// <summary>Drops every index-mirror watch. The composition root calls this before re-registering
    /// a freshly loaded load order's plugins, so a watch can never outlive the load order that asked for
    /// it and re-index a plugin this load order no longer holds.</summary>
    public void UnwatchAllIndexed()
    {
        lock (_gate)
        {
            foreach (var mirror in _mirrors.Values) mirror.Dispose();
            _mirrors.Clear();
        }
    }

    /// <summary>Every plugin currently classified as a genuine, unanswered external change — never
    /// <see cref="ExternalChangeClassification.SelfEcho"/> or
    /// <see cref="ExternalChangeClassification.CrashRecovery"/>, which this class filters out before a
    /// question is ever queued. One entry per plugin: a second detection before the first is answered
    /// replaces the queued question rather than duplicating it.</summary>
    public IReadOnlyList<UnansweredExternalChange> Unanswered()
    {
        lock (_gate) return [.. _unanswered.Values];
    }

    /// <summary>Drops a plugin's queued question — called once the dialog has been answered (Absorb,
    /// Keep, or a fresh detection has superseded it), so a stale question never keeps re-surfacing
    /// after it was already resolved through some other path (e.g. the load-time check).</summary>
    public void MarkAnswered(string modFolder, string pluginName)
    {
        lock (_gate) _unanswered.Remove(Key(modFolder, pluginName));
    }

    /// <summary>Feeds a classification computed elsewhere straight into the same unanswered-question
    /// queue the live watcher itself fills from <see cref="Settle"/> — the load-time hash check
    /// (fired from <c>MEditService.Api</c>'s reconcile handlers, which needs no live watch of its
    /// own to ask the question once) uses this so both triggers share one queue and one dialog
    /// surface.
    ///
    /// <para>Also the one place that sets <see cref="ExternalChangeDeferral"/>'s marker (the
    /// plugin is refused for editing from the instant a question is detected, not only
    /// after an explicit Esc) — both triggers land here, so both get the refusal without either
    /// remembering to set it themselves. Set <i>inside</i> the same lock, before <see cref="_unanswered"/>
    /// is updated: the lock's exit barrier is what makes "refused from the instant a question
    /// is detected" true for another thread, not merely likely — without it, a caller reacting to
    /// <see cref="Unanswered"/> going non-empty (e.g. the live-watch test's own polling loop) can
    /// observe that before the marker file is durably written, since a plain file write has no
    /// ordering relationship with a separate, unlocked dictionary write. Sharing the lock also
    /// serializes two plugins in the same mod folder being reported near-simultaneously, which would
    /// otherwise race on the same marker JSON file's read-modify-write.</para>
    /// </summary>
    public void ReportExternalChange(string modFolder, string pluginName, ExternalChangeClassification.ExternalChange classification)
    {
        lock (_gate)
        {
            ExternalChangeDeferral.Set(modFolder, pluginName,
                $"{pluginName} (in {Path.GetFileName(modFolder.TrimEnd(Path.DirectorySeparatorChar))}) changed outside " +
                "Modbench and is awaiting an answer — Absorb Upstream Update or Keep as My Edit.");
            _unanswered[Key(modFolder, pluginName)] = new UnansweredExternalChange(modFolder, pluginName, classification);
        }
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
            // Caught mid-write by another process still holding the file — the debounce timer having
            // fired at all means at least one Changed event landed, so there is nothing further to
            // wait for from this class; a genuinely torn read is not this class's problem to solve,
            // and the load-time hash check remains the backstop if this particular event is missed.
            return;
        }

        var classification = ExternalChangeClassifier.Classify(modFolder, pluginName, bytes);
        if (classification is ExternalChangeClassification.ExternalChange externalChange)
            ReportExternalChange(modFolder, pluginName, externalChange);
    }

    /// <summary>
    /// What a mirror watch does when the writes stop — re-hash, and say what actually
    /// happened. Identical bytes raise nothing, which is what keeps a <c>touch</c>, a mod manager's
    /// re-link or a rewrite of the same content from costing a re-index.
    ///
    /// <para>The remembered hash moves ahead of the handler so that the several events one write
    /// raises report it once, and is put back if the handler says it could not apply the change —
    /// see <see cref="IndexedBinaryChanged"/> for why an unretried failure would be worse than a
    /// duplicate. Put back only if nothing newer has landed meanwhile, so a retry never overwrites a
    /// later settle's answer with an older one.</para>
    /// </summary>
    private void SettleIndexed(string pluginName, string origin, string pluginPath)
    {
        var key = MirrorKey(origin, pluginName);
        IndexedBinaryEvent notification;
        string? previousHash;
        string? reportedHash;
        lock (_gate)
        {
            if (!_mirrors.TryGetValue(key, out var mirror)) return;
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
            // The subscriber is expected to answer rather than throw (see IndexMirror), but this
            // runs on a timer callback with no caller to catch anything: an escaping exception here
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

    /// <summary>One index-mirror watch and the bytes the index was last built from — null once the
    /// file's disappearance has been reported. Guarded by <c>_gate</c> like every other entry here.</summary>
    private sealed class MirrorEntry(string contentHash) : IDisposable
    {
        public string? ContentHash { get; set; } = contentHash;
        public WatchEntry? Watch { get; init; }
        public void Dispose() => Watch?.Dispose();
    }
}

/// <summary>What happened to one indexed binary on disk.</summary>
public enum IndexedBinaryChange
{
    /// <summary>Its bytes changed — the index must re-read it.</summary>
    Modified,

    /// <summary>It is gone — the index must forget it.</summary>
    Deleted,
}

/// <summary>ADR-0001: one indexed binary's disk event, carrying the compound plugin identity
/// (<c>origin</c> plus filename) the index is keyed by. Deliberately says nothing about mirror,
/// indexes or DuckDB — this assembly knows none of those, and that is enforced rather than agreed:
/// <c>BridgeKnowsNothingOfLoadOrdersTests</c> fails on any reference from here to the load order or
/// record-index namespaces (by literal text, so do not name them even in a comment). That is exactly
/// why this carries a bare (name, origin) pair where the rest of the codebase carries a
/// <c>PluginKey</c> — the type is on the wrong side of the boundary. <c>MEditService.Api</c>
/// reassembles one; deciding what to do about the event is its job.</summary>
public sealed record IndexedBinaryEvent(string PluginName, string Origin, string PluginPath, IndexedBinaryChange Change);

/// <summary>One plugin's unanswered external-change question, as the watcher (or the load-time
/// check, via the same classification) last observed it — what
/// <c>GET /plugins/external-changes/status</c> hands the extension to drive the one dialog.</summary>
public sealed record UnansweredExternalChange(string ModFolder, string PluginName, ExternalChangeClassification.ExternalChange Classification);
