using System.Timers;
using MEditService.Core.Source;
using Timer = System.Timers.Timer;

namespace MEditService.Bridge;

/// <summary>ADR-0046: one recursive watcher per mod folder in the load order, tracked or not. The
/// Source repository names what to watch; settling is per mod, so a batch is per mod while
/// projection stays per plugin.</summary>
public sealed class ModFolderWatcher : IDisposable
{
    private readonly TimeSpan _quiet;
    private readonly TimeSpan _maxWindow;
    private readonly object _gate = new();
    private readonly Dictionary<string, ModEntry> _mods = new(StringComparer.Ordinal);
    private readonly Dictionary<string, UnansweredExternalChange> _unanswered = new(StringComparer.Ordinal);

    // Past this many documents in one window the batch is projected whole: see SourceChangeApplier's
    // own measurement of a whole-plugin validate against a per-key refresh.
    private const int CoalesceThreshold = 32;

    /// <param name="quiet">Collapses several events into one settle. Defaults to 300ms.</param>
    /// <param name="maxWindow">The longest a mod's batch stays open. Defaults to 2s.</param>
    public ModFolderWatcher(TimeSpan? quiet = null, TimeSpan? maxWindow = null)
    {
        _quiet = quiet ?? TimeSpan.FromMilliseconds(300);
        _maxWindow = maxWindow ?? TimeSpan.FromSeconds(2);
    }

    /// <summary>ADR-0046: what the projector is handed once a mod's batch settles.</summary>
    public Action<IReadOnlyList<SourceChangeEvent>>? SourceChanged { get; set; }

    /// <summary>Raised once an external-change question is queued, whichever trigger found it.</summary>
    public Action<UnansweredExternalChange>? ExternalChangeReported { get; set; }

    /// <summary>ADR-0046 invariant 6: an OS overflow on a tracked plugin's classification route.</summary>
    public Action<string, string>? WatchOverflowed { get; set; }

    /// <summary>The indexed-binary counterpart of <see cref="WatchOverflowed"/>.</summary>
    public Action<string, string>? IndexedWatchOverflowed { get; set; }

    /// <summary>ADR-0001. A delegate, not an event, because the handler answers whether it applied: a
    /// false answer keeps the remembered hash so the next settle retries.</summary>
    public Func<IndexedBinaryEvent, bool>? IndexedBinaryChanged { get; set; }

    /// <summary>Registers <paramref name="pluginName"/> for classification: self-echo, crash recovery
    /// or a genuine external change, decided at settle by <see cref="ExternalChangeClassifier"/>.
    /// Arms the mod's watcher if this is its first registration.</summary>
    public void Watch(string modFolder, string pluginName, string pluginPath)
    {
        lock (_gate)
        {
            // A tracked mod (the only caller of this overload) always carries the source
            // registration too, which needs the subtree.
            if (ModEntryFor(modFolder, recursive: true) is not { } mod) return;
            var plugin = mod.PluginFor(pluginName);
            plugin.Path = pluginPath;
            plugin.ClassificationArmed = true;
        }
    }

    /// <summary>The Source watcher's own registration: a path under <paramref name="sourceRoot"/>
    /// refreshes the Index by key; a ref move refreshes the whole plugin.</summary>
    public void Watch(string modFolder, string sourceRoot, string pluginName, string origin)
    {
        lock (_gate)
        {
            if (ModEntryFor(modFolder, recursive: true) is not { } mod) return;
            var plugin = mod.PluginFor(pluginName);
            plugin.SourceRoot = sourceRoot;
            plugin.Origin = origin;
        }
    }

    /// <summary>ADR-0001: every other indexed binary, tracked or not, re-reads on change with no
    /// question asked. <paramref name="contentHash"/> is the baseline a settle compares against.</summary>
    public void WatchIndexed(string pluginName, string origin, string pluginPath, string contentHash)
    {
        var modFolder = Path.GetDirectoryName(pluginPath)
            ?? throw new ArgumentException($"'{pluginPath}' has no containing directory.", nameof(pluginPath));

        lock (_gate)
        {
            // Never recursive on its own: an untracked mod or the game's Data/ folder has no source
            // tree or git refs for this route to answer for, and Data/ can hold thousands of files.
            if (ModEntryFor(modFolder, recursive: false) is not { } mod) return;
            var plugin = mod.PluginFor(pluginName);
            plugin.Path = pluginPath;
            plugin.Origin = origin;
            plugin.IndexedArmed = true;
            plugin.RememberedHash = contentHash;
        }
    }

    /// <summary>The copy has no source to project from: its repository is gone, or the load order
    /// dropped it. Clears only source routing; a classification or indexed registration on the same
    /// plugin is untouched.</summary>
    public void Unwatch(string pluginName, string origin)
    {
        lock (_gate)
        {
            foreach (var mod in _mods.Values)
            {
                if (mod.Plugins.TryGetValue(pluginName, out var plugin)
                    && string.Equals(plugin.Origin, origin, StringComparison.OrdinalIgnoreCase))
                {
                    plugin.SourceRoot = null;
                }
            }
        }
    }

    /// <summary>Called before every reconcile's own re-registration, so a dropped plugin's source
    /// routing never outlives the load order that named it.</summary>
    public void UnwatchAll()
    {
        lock (_gate)
        {
            foreach (var mod in _mods.Values)
                foreach (var plugin in mod.Plugins.Values)
                    plugin.SourceRoot = null;
        }
    }

    /// <summary>The indexed-binary counterpart of <see cref="UnwatchAll"/>: called before every
    /// reconcile re-decides which plugins have a known baseline to watch.</summary>
    public void UnwatchAllIndexed()
    {
        lock (_gate)
        {
            foreach (var mod in _mods.Values)
                foreach (var plugin in mod.Plugins.Values)
                {
                    plugin.IndexedArmed = false;
                    plugin.RememberedHash = null;
                }
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

    /// <summary>Both triggers — the live watch and the load-time check — get
    /// <see cref="ExternalChangeDeferral"/>'s marker here.</summary>
    public void ReportExternalChange(
        string modFolder, string pluginName, ExternalChangeClassification.ExternalChange classification)
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

    // Called under _gate. Lazily arms the mod's watcher, recursive only once needed — the game's
    // Data/ folder never needs it. A vanished mod folder gets no watch, and no throw.
    private ModEntry? ModEntryFor(string modFolder, bool recursive)
    {
        if (_mods.TryGetValue(modFolder, out var existing))
        {
            // Upgraded, never downgraded: another plugin sharing the folder may still need it.
            if (recursive && !existing.Watcher.IncludeSubdirectories) existing.Watcher.IncludeSubdirectories = true;
            return existing;
        }

        FileSystemWatcher fsWatcher;
        try
        {
            fsWatcher = new FileSystemWatcher(modFolder)
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
        }
        catch (ArgumentException)
        {
            return null;
        }

        var mod = new ModEntry(modFolder, SourceRepository.GitWatchPathsIn(modFolder), fsWatcher,
            new Timer(_quiet.TotalMilliseconds) { AutoReset = false },
            new Timer(_maxWindow.TotalMilliseconds) { AutoReset = false });
        mod.QuietTimer.Elapsed += (_, _) => Settle(mod);
        mod.MaxWindowTimer.Elapsed += (_, _) => Settle(mod);
        fsWatcher.Changed += (_, e) => Observe(mod, e.FullPath);
        fsWatcher.Created += (_, e) => Observe(mod, e.FullPath);
        // A deletion is a settle like any other: the whole point of the indexed-binary route, and a
        // no-op for a plugin classification finds no bytes for.
        fsWatcher.Deleted += (_, e) => Observe(mod, e.FullPath);
        fsWatcher.Renamed += (_, e) => { Observe(mod, e.OldFullPath); Observe(mod, e.FullPath); };
        fsWatcher.Error += (_, _) => Interrupted(modFolder);
        fsWatcher.EnableRaisingEvents = true;

        _mods[modFolder] = mod;
        return mod;
    }

    // Called under _gate. A ref move, a document under a registered plugin's source root, or a
    // load-order plugin's own binary; everything else is dropped (a future ticket classifies it).
    private void Observe(ModEntry mod, string fullPath)
    {
        lock (_gate)
        {
            if (IsRefPath(mod.Git, fullPath))
            {
                foreach (var plugin in mod.Plugins.Values) plugin.WholePlugin = true;
            }
            else if (Under(mod.Git.GitDirectory, fullPath))
            {
                return; // anything else under .git is not this watcher's business
            }
            else if (SourcePluginFor(mod, fullPath) is { } sourcePlugin)
            {
                sourcePlugin.DocumentPaths.Add(fullPath);
            }
            else if (PluginFileFor(mod, fullPath) is { } filePlugin)
            {
                filePlugin.FileTouched = true;
            }
            else
            {
                return;
            }

            OpenOrExtendBatch(mod);
        }
    }

    // An operating-system overflow drops events, so nothing this mod's watch saw can be trusted.
    // A vanished root raises the same event, with nothing left to watch.
    private void Interrupted(string modFolder)
    {
        List<(string Name, string? Origin, bool ClassificationArmed, bool IndexedArmed)> targets;
        lock (_gate)
        {
            if (!_mods.TryGetValue(modFolder, out var mod)) return;
            if (!Directory.Exists(modFolder))
            {
                _mods.Remove(modFolder);
                mod.Dispose();
                return;
            }

            foreach (var plugin in mod.Plugins.Values)
                if (plugin.SourceRoot != null) plugin.WholePlugin = true;
            OpenOrExtendBatch(mod);

            targets = [.. mod.Plugins.Values
                .Select(p => (p.Name, p.Origin, p.ClassificationArmed, p.IndexedArmed))];
        }

        foreach (var (name, origin, classificationArmed, indexedArmed) in targets)
        {
            if (classificationArmed) RaiseSafely(() => WatchOverflowed?.Invoke(modFolder, name));
            if (indexedArmed) RaiseSafely(() => IndexedWatchOverflowed?.Invoke(name, origin ?? ""));
        }
    }

    // Called under _gate. Starts the bounding max-window timer once per batch, and always restarts
    // the quiet timer.
    private static void OpenOrExtendBatch(ModEntry mod)
    {
        if (!mod.BatchOpen)
        {
            mod.BatchOpen = true;
            mod.MaxWindowTimer.Stop();
            mod.MaxWindowTimer.Start();
        }

        mod.QuietTimer.Stop();
        mod.QuietTimer.Start();
    }

    // Fired by either of the mod's own timers. Settles every plugin with a pending source change
    // into one batch, and classifies or re-ingests every plugin whose own binary was touched.
    private void Settle(ModEntry mod)
    {
        List<SourceChangeEvent> batch;
        List<PluginEntry> touched;
        lock (_gate)
        {
            if (!mod.BatchOpen) return;
            mod.BatchOpen = false;
            mod.QuietTimer.Stop();
            mod.MaxWindowTimer.Stop();

            batch = [];
            touched = [];
            foreach (var plugin in mod.Plugins.Values)
            {
                if (plugin.SourceRoot != null && (plugin.DocumentPaths.Count > 0 || plugin.WholePlugin))
                {
                    var whole = plugin.WholePlugin || plugin.DocumentPaths.Count > CoalesceThreshold;
                    batch.Add(new SourceChangeEvent(
                        plugin.Name, plugin.Origin ?? "", mod.ModFolder,
                        whole ? SourceChangeScope.WholePlugin : SourceChangeScope.Documents,
                        whole ? [] : [.. plugin.DocumentPaths]));
                }
                plugin.DocumentPaths.Clear();
                plugin.WholePlugin = false;

                if (plugin.FileTouched)
                {
                    touched.Add(plugin);
                    plugin.FileTouched = false;
                }
            }
        }

        if (batch.Count > 0) RaiseSafely(() => SourceChanged?.Invoke(batch));
        foreach (var plugin in touched) SettleFile(mod.ModFolder, plugin);
    }

    private void SettleFile(string modFolder, PluginEntry plugin)
    {
        if (plugin.ClassificationArmed) SettleClassification(modFolder, plugin);
        if (plugin.IndexedArmed) SettleIndexed(plugin);
    }

    private void SettleClassification(string modFolder, PluginEntry plugin)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(plugin.Path!);
        }
        catch (IOException)
        {
            // Caught mid-write by a process still holding the file; the load-time hash check is the
            // backstop if this event is missed.
            return;
        }

        if (ExternalChangeClassifier.Classify(modFolder, plugin.Name, bytes)
            is ExternalChangeClassification.ExternalChange change)
        {
            ReportExternalChange(modFolder, plugin.Name, change);
        }
    }

    // Content, never events: identical bytes raise nothing, so a touch is free. The remembered hash
    // moves ahead of the handler and is put back on failure only if nothing newer has landed.
    private void SettleIndexed(PluginEntry plugin)
    {
        var pluginPath = plugin.Path!;
        IndexedBinaryEvent notification;
        string? previousHash;
        string? reportedHash;
        lock (_gate)
        {
            if (!plugin.IndexedArmed) return;
            previousHash = plugin.RememberedHash;

            if (!File.Exists(pluginPath))
            {
                // Already reported gone: a delete raises several events and the file stays absent, so
                // without this every one of them would remove the same rows again.
                if (previousHash == null) return;
                reportedHash = null;
                notification = new IndexedBinaryEvent(
                    plugin.Name, plugin.Origin ?? "", pluginPath, IndexedBinaryChange.Deleted);
            }
            else
            {
                if (PluginBinaryHash.OfFile(pluginPath) is not { } observed || observed == previousHash) return;
                reportedHash = observed;
                notification = new IndexedBinaryEvent(
                    plugin.Name, plugin.Origin ?? "", pluginPath, IndexedBinaryChange.Modified);
            }

            plugin.RememberedHash = reportedHash;
        }

        bool applied;
        try
        {
            applied = IndexedBinaryChanged?.Invoke(notification) ?? true;
        }
        catch
        {
            applied = false;
        }

        if (applied) return;

        lock (_gate)
        {
            if (plugin.RememberedHash == reportedHash) plugin.RememberedHash = previousHash;
        }
    }

    private static bool IsRefPath(GitWatchPaths git, string fullPath) =>
        fullPath.Equals(git.Head, StringComparison.Ordinal)
        || fullPath.Equals(git.PackedRefs, StringComparison.Ordinal)
        || Under(git.RefsDirectory, fullPath);

    private static bool Under(string directory, string fullPath) =>
        fullPath.Equals(directory, StringComparison.Ordinal)
        || fullPath.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.Ordinal);

    private static PluginEntry? SourcePluginFor(ModEntry mod, string fullPath) =>
        mod.Plugins.Values.FirstOrDefault(p => p.SourceRoot is { } root && Under(root, fullPath));

    private static PluginEntry? PluginFileFor(ModEntry mod, string fullPath) =>
        mod.Plugins.Values.FirstOrDefault(p => p.Path is { } path && fullPath.Equals(path, StringComparison.Ordinal));

    // Runs on the FileSystemWatcher's own thread or a timer callback, with no caller to catch
    // anything.
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

    private static string Key(string modFolder, string pluginName) => $"{modFolder} {pluginName}";

    public void Dispose()
    {
        lock (_gate)
        {
            foreach (var mod in _mods.Values) mod.Dispose();
            _mods.Clear();
        }
    }

    // One mod folder's watch: its recursive FileSystemWatcher, its git watch targets, its own quiet
    // and bounding timers, and its currently registered plugins. Guarded by _gate.
    private sealed class ModEntry(
        string modFolder, GitWatchPaths git, FileSystemWatcher watcher, Timer quietTimer, Timer maxWindowTimer)
        : IDisposable
    {
        public string ModFolder { get; } = modFolder;
        public GitWatchPaths Git { get; } = git;
        public FileSystemWatcher Watcher { get; } = watcher;
        public Timer QuietTimer { get; } = quietTimer;
        public Timer MaxWindowTimer { get; } = maxWindowTimer;
        public bool BatchOpen { get; set; }
        public Dictionary<string, PluginEntry> Plugins { get; } = new(StringComparer.Ordinal);

        public PluginEntry PluginFor(string name)
        {
            if (!Plugins.TryGetValue(name, out var plugin))
            {
                plugin = new PluginEntry(name);
                Plugins[name] = plugin;
            }
            return plugin;
        }

        public void Dispose()
        {
            Watcher.Dispose();
            QuietTimer.Dispose();
            MaxWindowTimer.Dispose();
        }
    }

    // One plugin's registration within its mod: SourceRoot, ClassificationArmed and IndexedArmed set
    // independently, by whichever of Watch/WatchIndexed named this plugin. Guarded by _gate.
    private sealed class PluginEntry(string name)
    {
        public string Name { get; } = name;
        public string? Origin { get; set; }
        public string? Path { get; set; }
        public string? SourceRoot { get; set; }
        public bool ClassificationArmed { get; set; }
        public bool IndexedArmed { get; set; }
        public string? RememberedHash { get; set; }
        public HashSet<string> DocumentPaths { get; } = new(StringComparer.Ordinal);
        public bool WholePlugin { get; set; }
        public bool FileTouched { get; set; }
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
