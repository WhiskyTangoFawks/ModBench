using System.Timers;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>ADR-0046 invariant 4: the Source watcher. One watch per tracked plugin copy, rooted on
/// the mod folder — the root that exists before and after Track creates the tree and the repository
/// under it.</summary>
public sealed class SourceChangeWatcher : IDisposable
{
    private readonly TimeSpan _debounce;
    private readonly object _gate = new();
    private readonly Dictionary<string, WatchEntry> _entries = new(StringComparer.Ordinal);

    /// <param name="debounce">Collapses the several events one save, one git command or one editor's
    /// write-out raises into a single projection. Defaults to 300ms; tests shorten it.</param>
    public SourceChangeWatcher(TimeSpan? debounce = null)
    {
        _debounce = debounce ?? TimeSpan.FromMilliseconds(300);
    }

    // Past this many documents in one window the batch is projected whole: a whole-plugin validate of
    // the real-data fixture measures about 230ms and asks git once, where a per-key refresh asks it
    // once per key.
    private const int CoalesceThreshold = 32;

    /// <summary>ADR-0046: what the projector is handed. A delegate, not an event, because there is
    /// exactly one subscriber and it answers by projecting. Raised outside the lock, since the
    /// handler re-projects a plugin.</summary>
    public Action<SourceChangeEvent>? SourceChanged { get; set; }

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

            var debounceTimer = new Timer(_debounce.TotalMilliseconds) { AutoReset = false };
            var entry = new WatchEntry(fsWatcher, debounceTimer, modFolder, sourceRoot, pluginName, origin);
            debounceTimer.Elapsed += (_, _) => Settle(key);
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

            entry.Debounce.Stop();
            entry.Debounce.Start();
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
            entry.Debounce.Stop();
            entry.Debounce.Start();
        }
    }

    private void Settle(string key)
    {
        SourceChangeEvent change;
        lock (_gate)
        {
            if (!_entries.TryGetValue(key, out var entry)) return;

            var whole = entry.WholePlugin || entry.Paths.Count > CoalesceThreshold;
            change = new SourceChangeEvent(
                entry.PluginName, entry.Origin, entry.ModFolder,
                whole ? SourceChangeScope.WholePlugin : SourceChangeScope.Documents,
                whole ? [] : [.. entry.Paths]);
            entry.Paths.Clear();
            entry.WholePlugin = false;
        }

        try
        {
            SourceChanged?.Invoke(change);
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
    }

    // Paths and WholePlugin are the batch this window has accumulated. Guarded by _gate.
    private sealed class WatchEntry(
        FileSystemWatcher watcher, Timer debounce, string modFolder, string sourceRoot, string pluginName, string origin)
        : IDisposable
    {
        public Timer Debounce { get; } = debounce;
        public string ModFolder { get; } = modFolder;
        public string SourceRoot { get; } = sourceRoot;
        public string GitDirectory { get; } = Path.Combine(modFolder, ".git");
        public string PluginName { get; } = pluginName;
        public string Origin { get; } = origin;
        public HashSet<string> Paths { get; } = new(StringComparer.Ordinal);
        public bool WholePlugin { get; set; }

        public void Dispose()
        {
            watcher.Dispose();
            Debounce.Dispose();
        }
    }
}

/// <summary>Which projection the batch asks for: the named documents, or the whole copy when a ref
/// moved, the operating system dropped events, or the burst was wider than one batch is
/// worth.</summary>
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
