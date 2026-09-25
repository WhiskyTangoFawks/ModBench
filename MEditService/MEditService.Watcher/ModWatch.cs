using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Watcher;

/// <summary>Which projection the batch asks for: the named documents, or the whole plugin when a
/// ref moved, the operating system dropped events, or the burst was wider than one batch is
/// worth.</summary>
internal enum SourceChangeScope
{
    Documents,
    WholePlugin,
}

/// <summary>ADR-0015 invariant 2: one settled batch of source changes to one plugin.</summary>
internal sealed record SourceChangeEvent(
    string PluginName, string Origin, string ModFolder, SourceChangeScope Scope, IReadOnlyList<string> Paths);

/// <summary>A registered plugin's own binary, touched in the window that just closed.</summary>
internal sealed record TouchedBinary(PluginAddress Key, string Path);

/// <summary>Everything one mod folder's window collected before it closed: the source batch, the
/// binaries touched, and whether any other path under the mod was.</summary>
internal sealed record SettledWindow(
    IReadOnlyList<SourceChangeEvent> Batch, IReadOnlyList<TouchedBinary> Binaries, bool ModTouched)
{
    public static readonly SettledWindow Empty = new([], [], false);

    public bool IsEmpty => Batch.Count == 0 && Binaries.Count == 0 && !ModTouched;
}

/// <summary>One mod folder's watch: its FileSystemWatcher, its git watch targets, its two timers on
/// the injected clock, and the plugins the snapshot registered in it. Routes each path into the
/// next window for the watcher to settle.</summary>
internal sealed class ModWatch : IDisposable
{
    // Past this many documents in one window the batch is projected whole: one git listing for the
    // plugin costs less than asking git per named record.
    private const int CoalesceThreshold = 32;

    private readonly object _lock = new();
    private readonly FileSystemWatcher _watcher;
    private readonly ITimer _quietTimer;
    private readonly ITimer _maxWindowTimer;
    private readonly TimeSpan _quiet;
    private readonly TimeSpan _maxWindow;
    private readonly GitWatchPaths _git;
    private readonly bool _upgradable;
    private readonly Dictionary<string, PluginEntry> _plugins = new(StringComparer.Ordinal);
    private bool _batchOpen;
    private bool _modTouched;
    private bool _disposed;

    /// <summary>Throws <see cref="ArgumentException"/> when the folder is not on disk, as
    /// FileSystemWatcher does: a vanished mod folder gets no watch.</summary>
    public ModWatch(
        string modFolder, bool recursive, bool upgradable, TimeSpan quiet, TimeSpan maxWindow,
        TimeProvider time, Action<ModWatch> settle, Action<ModWatch> overflow)
    {
        ModFolder = modFolder;
        _git = SourceRepository.GitWatchPathsIn(modFolder);
        _upgradable = upgradable;
        _quiet = quiet;
        _maxWindow = maxWindow;
        _watcher = new FileSystemWatcher(modFolder)
        {
            IncludeSubdirectories = recursive,
            // FileName and DirectoryName: git and a compile both write through a rename, and
            // .NET's inotify-backed Linux watcher gates Renamed on those bits.
            NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size
                            | NotifyFilters.FileName | NotifyFilters.DirectoryName,
            // Wider than the 8KB default: a whole mod folder is a wider surface than one file's
            // directory, and Error is still the backstop when a burst outruns even this.
            InternalBufferSize = 65536,
        };
        try
        {
            // Both idle until a batch opens: an armed timer fires once, and OpenOrExtendBatch is
            // the only thing that arms one.
            _quietTimer = time.CreateTimer(_ => settle(this), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            _maxWindowTimer = time.CreateTimer(_ => settle(this), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            _watcher.Changed += (_, e) => Observe(e.FullPath);
            _watcher.Created += (_, e) => Observe(e.FullPath, appeared: true);
            // A deletion is a settle like any other: the whole point of the indexed-binary route,
            // and a no-op for a plugin classification finds no bytes for.
            _watcher.Deleted += (_, e) => Observe(e.FullPath);
            _watcher.Renamed += (_, e) => { Observe(e.OldFullPath); Observe(e.FullPath, appeared: true); };
            _watcher.Error += (_, _) => overflow(this);
            _watcher.EnableRaisingEvents = true;
        }
        catch
        {
            _watcher.Dispose();
            throw;
        }
    }

    public string ModFolder { get; }

    public bool FolderExists => Directory.Exists(ModFolder);

    /// <summary>Every registered plugin, for the validation an overflow asks of each.</summary>
    public IReadOnlyList<PluginAddress> RegisteredKeys
    {
        get { lock (_lock) return [.. _plugins.Values.Select(p => new PluginAddress(p.Name, p.Origin))]; }
    }

    /// <summary>Registers a plugin the snapshot holds in this folder: its binary path, and the source
    /// root the repository would give it, whether or not that root exists yet.</summary>
    public void Register(string name, string origin, string path)
    {
        lock (_lock)
        {
            _plugins[name] = new PluginEntry(name, origin, path, SourceRepository.RootIn(ModFolder, name));
        }
    }

    /// <summary>Forgets every registration, ahead of the snapshot registering what it now
    /// holds.</summary>
    public void ClearRegistrations()
    {
        lock (_lock) _plugins.Clear();
    }

    /// <summary>Upgraded, never downgraded: the folder holds a source tree or a repository, so
    /// everything under it routes.</summary>
    public void EnsureRecursive()
    {
        lock (_lock)
        {
            if (_disposed || _watcher.IncludeSubdirectories) return;
            _watcher.IncludeSubdirectories = true;
        }
    }

    /// <summary>An operating-system overflow dropped events, so nothing this window saw can be
    /// trusted: every plugin is re-projected whole at the next settle.</summary>
    public void MarkEverythingTouched()
    {
        lock (_lock)
        {
            if (_disposed) return;
            foreach (var plugin in _plugins.Values) plugin.WholePlugin = true;
            OpenOrExtendBatch();
        }
    }

    /// <summary>Closes the open window and hands back what it collected; empty when none was
    /// open, which is also what a disposed watch answers.</summary>
    public SettledWindow Close()
    {
        lock (_lock)
        {
            if (!_batchOpen) return SettledWindow.Empty;
            _batchOpen = false;
            _quietTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
            _maxWindowTimer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

            var batch = new List<SourceChangeEvent>();
            var binaries = new List<TouchedBinary>();
            foreach (var plugin in _plugins.Values)
            {
                if (plugin.DocumentPaths.Count > 0 || plugin.WholePlugin)
                {
                    var whole = plugin.WholePlugin || plugin.DocumentPaths.Count > CoalesceThreshold;
                    batch.Add(new SourceChangeEvent(
                        plugin.Name, plugin.Origin, ModFolder,
                        whole ? SourceChangeScope.WholePlugin : SourceChangeScope.Documents,
                        whole ? [] : [.. plugin.DocumentPaths]));
                }
                plugin.DocumentPaths.Clear();
                plugin.WholePlugin = false;

                if (plugin.FileTouched)
                {
                    binaries.Add(new TouchedBinary(new PluginAddress(plugin.Name, plugin.Origin), plugin.Path));
                    plugin.FileTouched = false;
                }
            }

            var modTouched = _modTouched;
            _modTouched = false;
            return new SettledWindow(batch, binaries, modTouched);
        }
    }

    // A ref move, a document under a registered source root, a registered binary, the source tree
    // appearing under a top-level watch, or another external-change candidate: each makes the mod
    // a candidate for the next settle.
    private void Observe(string fullPath, bool appeared = false)
    {
        lock (_lock)
        {
            if (_disposed) return;

            if (SourceTreeAppeared(fullPath))
            {
                // Nothing the restart between the two watch shapes dropped can be named, so every
                // plugin is projected whole once the tree settles.
                _watcher.IncludeSubdirectories = true;
                foreach (var plugin in _plugins.Values) plugin.WholePlugin = true;
            }
            else if (IsRefPath(fullPath))
            {
                foreach (var plugin in _plugins.Values) plugin.WholePlugin = true;
            }
            else if (Under(_git.GitDirectory, fullPath))
            {
                return;
            }
            else if (_plugins.Values.FirstOrDefault(p => Under(p.SourceRoot, fullPath)) is { } sourcePlugin)
            {
                // The operating system watches a folder that appears only once its creation is
                // handled, so what was written into it may reach no batch.
                if (appeared && Directory.Exists(fullPath)) sourcePlugin.WholePlugin = true;
                else sourcePlugin.DocumentPaths.Add(fullPath);
            }
            else if (_plugins.Values.FirstOrDefault(p => fullPath.Equals(p.Path, StringComparison.Ordinal)) is { } filePlugin)
            {
                filePlugin.FileTouched = true;
            }
            else
            {
                // Commands re-checks git's status at settle rather than trusting this path, so
                // which file it was does not matter here.
                _modTouched = true;
            }

            OpenOrExtendBatch();
        }
    }

    // Called under _lock, ahead of the repository's own early return: a top-level watch sees the
    // repository (Track's first write) or the folder every source root shares appear, and from
    // then on everything under the mod matters.
    private bool SourceTreeAppeared(string fullPath) =>
        _upgradable
        && !_watcher.IncludeSubdirectories
        && (fullPath.Equals(_git.GitDirectory, StringComparison.Ordinal)
            || _plugins.Values.Any(p => Under(fullPath, p.SourceRoot)));

    // Called under _lock. Starts the bounding max-window timer once per batch, and always restarts
    // the quiet timer.
    private void OpenOrExtendBatch()
    {
        if (!_batchOpen)
        {
            _batchOpen = true;
            _maxWindowTimer.Change(_maxWindow, Timeout.InfiniteTimeSpan);
        }

        _quietTimer.Change(_quiet, Timeout.InfiniteTimeSpan);
    }

    private bool IsRefPath(string fullPath) =>
        fullPath.Equals(_git.Head, StringComparison.Ordinal)
        || fullPath.Equals(_git.PackedRefs, StringComparison.Ordinal)
        || Under(_git.RefsDirectory, fullPath);

    private static bool Under(string directory, string fullPath) =>
        fullPath.Equals(directory, StringComparison.Ordinal)
        || fullPath.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    // Closing the batch under the lock is what stops a callback already queued from touching a
    // disposed timer: it finds no window open and leaves.
    public void Dispose()
    {
        lock (_lock)
        {
            if (_disposed) return;
            _disposed = true;
            _batchOpen = false;
            _watcher.Dispose();
            _quietTimer.Dispose();
            _maxWindowTimer.Dispose();
        }
    }

    // One plugin's registration within its mod. Guarded by _lock.
    private sealed class PluginEntry(string name, string origin, string path, string sourceRoot)
    {
        public string Name { get; } = name;
        public string Origin { get; } = origin;
        public string Path { get; } = path;
        public string SourceRoot { get; } = sourceRoot;
        public HashSet<string> DocumentPaths { get; } = new(StringComparer.Ordinal);
        public bool WholePlugin { get; set; }
        public bool FileTouched { get; set; }
    }
}
