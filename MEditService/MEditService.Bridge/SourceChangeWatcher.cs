using System.Timers;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>ADR-0046 invariant 4: the Source watcher. Settling is watcher-wide: any event on any
/// watch restarts one shared quiet timer, so a write spanning several plugins lands in one
/// batch.</summary>
public sealed class SourceChangeWatcher : IDisposable
{
    private readonly TimeSpan _quiet;
    private readonly TimeSpan _maxWindow;
    private readonly object _gate = new();
    private readonly Dictionary<string, WatchEntry> _entries = new(StringComparer.Ordinal);

    // Shared across every watched plugin. _quietTimer restarts on any event, anywhere; _maxWindowTimer
    // starts once a batch opens and is never restarted, so a stream that never goes quiet still settles.
    private readonly Timer _quietTimer;
    private readonly Timer _maxWindowTimer;
    private bool _batchOpen;

    /// <param name="quiet">Collapses several events into one projection. Defaults to 300ms.</param>
    /// <param name="maxWindow">The longest a batch stays open. Defaults to 2s.</param>
    public SourceChangeWatcher(TimeSpan? quiet = null, TimeSpan? maxWindow = null)
    {
        _quiet = quiet ?? TimeSpan.FromMilliseconds(300);
        _maxWindow = maxWindow ?? TimeSpan.FromSeconds(2);

        _quietTimer = new Timer(_quiet.TotalMilliseconds) { AutoReset = false };
        _quietTimer.Elapsed += (_, _) => Settle();
        _maxWindowTimer = new Timer(_maxWindow.TotalMilliseconds) { AutoReset = false };
        _maxWindowTimer.Elapsed += (_, _) => Settle();
    }

    // Past this many documents in one window the batch is projected whole: a whole-plugin validate of
    // the real-data fixture measures about 230ms and asks git once, where a per-key refresh asks it
    // once per key.
    private const int CoalesceThreshold = 32;

    /// <summary>ADR-0046: what the projector is handed — every plugin's settled batch together. A
    /// delegate, not an event, because there is exactly one subscriber and it answers by
    /// projecting.</summary>
    public Action<IReadOnlyList<SourceChangeEvent>>? SourceChanged { get; set; }

    /// <summary>Re-watching an already-watched copy replaces the previous watch. A mod folder that has
    /// vanished since the load order named it gets no watch, and no throw.</summary>
    public void Watch(string modFolder, string sourceRoot, string pluginName, string origin)
    {
        var key = Key(origin, pluginName);
        lock (_gate)
        {
            if (_entries.Remove(key, out var existing)) existing.Dispose();

            FileSystemWatcher fsWatcher;
            try
            {
                fsWatcher = new FileSystemWatcher(modFolder)
                {
                    IncludeSubdirectories = true,
                    // FileName and DirectoryName are required for Renamed to fire: git writes through
                    // a rename, and .NET's inotify-backed Linux watcher gates Renamed on those bits.
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size
                                   | NotifyFilters.FileName | NotifyFilters.DirectoryName,
                };
            }
            catch (ArgumentException)
            {
                return;
            }

            var entry = new WatchEntry(fsWatcher, modFolder, sourceRoot, pluginName, origin);
            fsWatcher.Changed += (_, e) => Observe(entry, e.FullPath);
            fsWatcher.Created += (_, e) => Observe(entry, e.FullPath);
            fsWatcher.Deleted += (_, e) => Observe(entry, e.FullPath);
            fsWatcher.Renamed += (_, e) => { Observe(entry, e.OldFullPath); Observe(entry, e.FullPath); };
            fsWatcher.Error += (_, _) => Interrupted(key);
            fsWatcher.EnableRaisingEvents = true;
            _entries[key] = entry;
        }
    }

    /// <summary>The copy has no source to project from: its repository is gone, or the load order
    /// dropped it. Watching an untracked folder would validate a plugin nothing can answer
    /// for.</summary>
    public void Unwatch(string pluginName, string origin)
    {
        lock (_gate)
        {
            if (_entries.Remove(Key(origin, pluginName), out var entry)) entry.Dispose();
        }
    }

    /// <summary>Called before re-registering a freshly reconciled load order, so a watch never
    /// outlives the load order that asked for it.</summary>
    public void UnwatchAll()
    {
        lock (_gate)
        {
            foreach (var entry in _entries.Values) entry.Dispose();
            _entries.Clear();
        }
    }

    // The two shapes a projection follows from: a document under this plugin's source root, and the
    // refs git rewrites on commit, checkout and reset. A mod folder holds far more than either.
    private void Observe(WatchEntry entry, string fullPath)
    {
        lock (_gate)
        {
            if (fullPath.StartsWith(entry.GitDirectory, StringComparison.Ordinal))
            {
                if (!NamesARef(fullPath)) return;
                entry.WholePlugin = true;
            }
            else if (fullPath.StartsWith(entry.SourceRoot, StringComparison.Ordinal))
            {
                entry.Paths.Add(fullPath);
            }
            else
            {
                return;
            }

            OpenOrExtendBatch();
        }
    }

    private static bool NamesARef(string fullPath) =>
        Path.GetFileName(fullPath) is "HEAD" or "packed-refs"
        || fullPath.Contains($"{Path.DirectorySeparatorChar}refs{Path.DirectorySeparatorChar}", StringComparison.Ordinal);

    // An operating-system overflow drops events, so nothing this copy holds can be believed and the
    // whole plugin is validated. A vanished root raises the same event, with nothing left to watch.
    private void Interrupted(string key)
    {
        lock (_gate)
        {
            if (!_entries.TryGetValue(key, out var entry)) return;
            if (!Directory.Exists(entry.ModFolder))
            {
                _entries.Remove(key);
                entry.Dispose();
                return;
            }

            entry.WholePlugin = true;
            OpenOrExtendBatch();
        }
    }

    // Called under _gate. Starts the bounding max-window timer once per batch, and always restarts
    // the quiet timer.
    private void OpenOrExtendBatch()
    {
        if (!_batchOpen)
        {
            _batchOpen = true;
            _maxWindowTimer.Stop();
            _maxWindowTimer.Start();
        }

        _quietTimer.Stop();
        _quietTimer.Start();
    }

    // Fired by either timer. Settles every plugin with a pending change into one batch, so a write
    // spanning several plugins is one projection rather than one per plugin.
    private void Settle()
    {
        List<SourceChangeEvent> batch;
        lock (_gate)
        {
            if (!_batchOpen) return;
            _batchOpen = false;
            _quietTimer.Stop();
            _maxWindowTimer.Stop();

            batch = [];
            foreach (var entry in _entries.Values)
            {
                if (entry.Paths.Count == 0 && !entry.WholePlugin) continue;

                var whole = entry.WholePlugin || entry.Paths.Count > CoalesceThreshold;
                batch.Add(new SourceChangeEvent(
                    entry.PluginName, entry.Origin, entry.ModFolder,
                    whole ? SourceChangeScope.WholePlugin : SourceChangeScope.Documents,
                    whole ? [] : [.. entry.Paths]));
                entry.Paths.Clear();
                entry.WholePlugin = false;
            }
        }

        if (batch.Count == 0) return;

        try
        {
            SourceChanged?.Invoke(batch);
        }
        catch (Exception ex)
        {
            // The subscriber answers rather than throws, but this runs on a timer callback with no
            // caller to catch anything: an escaping exception would take the process down over one
            // file event.
            System.Diagnostics.Debug.WriteLine(ex);
        }
    }

    // (origin, plugin) — the compound plugin identity (ADR-0036), not the mod folder: two copies of
    // one plugin name are two watches.
    private static string Key(string origin, string pluginName) =>
        string.Concat(origin, " ", pluginName);

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var entry in _entries.Values) entry.Dispose();
            _entries.Clear();
        }

        _quietTimer.Dispose();
        _maxWindowTimer.Dispose();
    }

    // Paths and WholePlugin are the batch this window has accumulated. Guarded by _gate.
    private sealed class WatchEntry(
        FileSystemWatcher watcher, string modFolder, string sourceRoot, string pluginName, string origin)
        : IDisposable
    {
        public string ModFolder { get; } = modFolder;
        public string SourceRoot { get; } = sourceRoot;
        public string GitDirectory { get; } = Path.Combine(modFolder, ".git");
        public string PluginName { get; } = pluginName;
        public string Origin { get; } = origin;
        public HashSet<string> Paths { get; } = new(StringComparer.Ordinal);
        public bool WholePlugin { get; set; }

        public void Dispose() => watcher.Dispose();
    }
}

/// <summary>Which projection the batch asks for: the named documents, or the whole copy when a ref
/// moved, the operating system dropped events, or the burst was wider than one batch is worth.</summary>
public enum SourceChangeScope
{
    Documents,
    WholePlugin,
}

/// <summary>ADR-0046: one settled batch of source changes to one plugin copy. A bare (name, origin)
/// pair rather than a PluginKey: this assembly may not reference the load order or record-index
/// namespaces.</summary>
public sealed record SourceChangeEvent(
    string PluginName, string Origin, string ModFolder, SourceChangeScope Scope, IReadOnlyList<string> Paths);
