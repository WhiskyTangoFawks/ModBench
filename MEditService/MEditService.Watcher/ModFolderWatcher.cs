using System.Timers;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceRepo;
using Microsoft.Extensions.Logging;
using Timer = System.Timers.Timer;

namespace MEditService.Watcher;

/// <summary>ADR-0014 invariant 1: the driving adapter over the mod folders. One recursive watcher
/// per mod folder in the load order, tracked or not, and the routing of whatever settles under
/// it.</summary>
public sealed class ModFolderWatcher : IDisposable
{
    private readonly LoadOrderHolder _holder;
    private readonly IRefreshIndex _index;
    private readonly INotificationPublisher _notifications;
    private readonly ILogger _logger;
    private readonly TimeSpan _quiet;
    private readonly TimeSpan _maxWindow;
    private readonly object _gate = new();
    private readonly Dictionary<string, ModEntry> _mods = new(StringComparer.Ordinal);

    // Past this many documents in one window the batch is projected whole: one git listing for the
    // copy costs less than asking git per named record.
    private const int CoalesceThreshold = 32;

    /// <summary>The 300ms default collapses several events into one settle; the 2s default bounds
    /// how long a mod's batch stays open when the stream never goes quiet.</summary>
    public ModFolderWatcher(
        LoadOrderHolder holder,
        IRefreshIndex index,
        INotificationPublisher notifications,
        ILogger logger,
        TimeSpan? quiet = null,
        TimeSpan? maxWindow = null)
    {
        _holder = holder;
        _index = index;
        _notifications = notifications;
        _logger = logger;
        _quiet = quiet ?? TimeSpan.FromMilliseconds(300);
        _maxWindow = maxWindow ?? TimeSpan.FromSeconds(2);
    }

    /// <summary>The watch set the load order now implies, and the check for everything that changed
    /// while no watcher ran. Returns what only a repair can answer for.</summary>
    public IReadOnlyList<CrashRepairOffer> Rearm(LoadOrderSnapshot order)
    {
        // A watch must never outlive the load order that asked for it, or a plugin the load order
        // does not hold would keep projecting itself into the Index.
        UnwatchAll();
        UnwatchAllIndexed();

        var offers = new List<CrashRepairOffer>();
        // Grouped by mod folder: Commands settles once per mod (ADR-0003), covering every tracked
        // plugin the mod holds in one pass, exactly as the live watcher's settle does.
        var byModFolder = new Dictionary<string, List<(string Name, string Origin)>>(StringComparer.Ordinal);

        foreach (var plugin in order.Copies)
        {
            var key = plugin.Key;
            // Before anything under it is registered: a registration then upgrades a watch that is
            // already running, which is what lets Track's own tree land under one.
            if (LoadOrderSnapshot.ModFolderOf(plugin.Origin, plugin.Path) is { } folder) WatchTopLevelOf(folder);

            if (SourceRepository.TrackedModFolderOf(order, key) is not { } modFolder)
            {
                // ADR-0009: every other indexed binary, the game's Data/ masters included, gets an
                // indexed-binary watch: a write by another tool is answered by re-reading it, not by
                // asking the user. No indexed hash, nothing to compare against.
                if (_index.IndexedContentHash(key) is { } contentHash)
                    WatchIndexed(plugin.Name, plugin.Origin, plugin.Path, contentHash);
                continue;
            }

            Watch(modFolder, SourceRepository.RootIn(modFolder, plugin.Name), plugin.Name, plugin.Origin);

            try
            {
                File.ReadAllBytes(plugin.Path);
            }
            catch (IOException ex)
            {
                // Unreadable: a repair offer, never Commands' own question.
                _logger.LogWarning(ex, "Could not read {Plugin} for the external-change load-time check", plugin.Name);
                offers.Add(new CrashRepairOffer(plugin.Name, plugin.Origin, CrashRepairReason.MissingOrUnreadableBinary));
                continue;
            }

            if (!byModFolder.TryGetValue(modFolder, out var entries))
                byModFolder[modFolder] = entries = [];
            entries.Add((plugin.Name, plugin.Origin));

            Watch(modFolder, plugin.Name, plugin.Path);
        }

        foreach (var (modFolder, entries) in byModFolder)
            SettleAtLoad(modFolder, entries, offers);

        return offers;
    }

    // "A tracked mod settled" (ADR-0015), fired once per mod at load. A crash-recovery verdict
    // becomes this mod's repair offers; any other verdict is Commands' own affair.
    private void SettleAtLoad(string modFolder, List<(string Name, string Origin)> entries, List<CrashRepairOffer> offers)
    {
        switch (TrackedModSettled.Handle(_holder.Current, modFolder, _notifications))
        {
            case TrackedModSettledOutcome.QuestionOpened:
                if (_logger.IsEnabled(LogLevel.Information))
                    _logger.LogInformation("External change detected at load for {ModFolder}", modFolder);
                break;

            case TrackedModSettledOutcome.CrashRecovery:
                foreach (var (name, origin) in entries)
                {
                    if (_logger.IsEnabled(LogLevel.Information))
                        _logger.LogInformation("Interrupted compile detected at load for {Plugin} ({Origin})", name, origin);
                    offers.Add(new CrashRepairOffer(name, origin, CrashRepairReason.InterruptedCompile));
                }
                break;
        }
    }

    /// <summary>Registration as tracked, before Track writes a byte: every loaded copy under
    /// <paramref name="origin"/> gets its source root, upgrading the mod's watch to the subtree the
    /// tree and the commit ending it both land in.</summary>
    public void WatchSourceOf(string origin)
    {
        var order = _holder.Current;
        if (order.ModFolderOfOrigin(origin) is not { } modFolder) return;
        foreach (var copy in order.CopiesOfOrigin(origin))
            Watch(modFolder, SourceRepository.RootIn(modFolder, copy.Name), copy.Name, copy.Origin);
    }

    // No subtree: the folder is watched before it is known to hold anything worth recursing into,
    // and every registration upgrades rather than replaces.
    private void WatchTopLevelOf(string modFolder)
    {
        lock (_gate) ModEntryFor(modFolder, recursive: false);
    }

    /// <summary>Registers <paramref name="pluginName"/> so a settle sends Commands "a tracked mod
    /// settled" for this mod. Arms the mod's watcher if this is its first registration.</summary>
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

    /// <summary>The Source registration: a path under <paramref name="sourceRoot"/> refreshes the
    /// Index by key; a ref move refreshes the whole plugin.</summary>
    internal void Watch(string modFolder, string sourceRoot, string pluginName, string origin)
    {
        lock (_gate)
        {
            if (ModEntryFor(modFolder, recursive: true) is not { } mod) return;
            var plugin = mod.PluginFor(pluginName);
            plugin.SourceRoot = sourceRoot;
            plugin.Origin = origin;
        }
    }

    /// <summary>ADR-0009: every other indexed binary, tracked or not, re-reads on change with no
    /// question asked. <paramref name="contentHash"/> is the baseline a settle compares against.</summary>
    internal void WatchIndexed(string pluginName, string origin, string pluginPath, string contentHash)
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

    private void UnwatchAll()
    {
        lock (_gate)
        {
            foreach (var mod in _mods.Values)
                foreach (var plugin in mod.Plugins.Values)
                    plugin.SourceRoot = null;
        }
    }

    /// <summary>The indexed-binary counterpart of the source unwatch: every reconcile re-decides
    /// which plugins have a known baseline to watch.</summary>
    internal void UnwatchAllIndexed()
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

    private static string OriginOf(LoadOrderSnapshot loadOrder, string modFolder, string pluginName) =>
        loadOrder.Copies.FirstOrDefault(copy =>
            copy.Name.Equals(pluginName, StringComparison.OrdinalIgnoreCase)
            && LoadOrderSnapshot.ModFolderOf(copy.Origin, copy.Path) == modFolder)?.Origin ?? "";

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

    // Called under _gate. A ref move, a document under a registered plugin's source root, a
    // load-order plugin's own binary, or any other path, which makes the mod a candidate for the
    // classifier when it settles.
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
                return;
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
                // Neither source, refs nor a registered plugin's own binary: an external-change
                // candidate. The classifier re-checks git's status at settle rather than trusting
                // this path, so which file it was does not matter here.
                mod.OtherCandidateTouched = true;
            }

            OpenOrExtendBatch(mod);
        }
    }

    /// <summary>An operating-system overflow drops events, so nothing this mod's watch saw can be
    /// trusted. A vanished root raises the same event, with nothing left to watch.</summary>
    internal void Interrupted(string modFolder)
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
            if (!classificationArmed && !indexedArmed) continue;
            // The registration first: a copy the load order has since dropped still knows the origin
            // its watch was armed with. The load order answers for a classification-only watch,
            // which carries none.
            var key = new PluginKey(name, origin ?? OriginOf(_holder.Current, modFolder, name));
            RaiseSafely(() => ValidateAfterOverflow(key));
        }
    }

    /// <summary>ADR-0015 invariant 4: an OS overflow dropped events, so this copy is compared by
    /// content hash rather than trusted.</summary>
    internal void ValidateAfterOverflow(PluginKey key)
    {
        try
        {
            foreach (var report in _index.ValidateIndex(key))
            {
                foreach (var failure in report.Failures)
                    _logger.LogWarning("Validating {Plugin} after a watch overflow: {Failure}", key.Name, failure);
                if (report.NeedsRebuild) _notifications.Publish(new PluginChangedNotification(key, _index.Sequence));
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Could not validate {Plugin} after a watch overflow; it will be re-checked at the next reconcile",
                key.Name);
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

    // Fired by either of the mod's own timers: one source batch, one mod-wide external-change
    // classification, and the indexed-binary re-ingest, each for whatever this window touched.
    private void Settle(ModEntry mod)
    {
        List<SourceChangeEvent> batch;
        List<PluginEntry> indexedTouched;
        bool classify;
        lock (_gate)
        {
            if (!mod.BatchOpen) return;
            mod.BatchOpen = false;
            mod.QuietTimer.Stop();
            mod.MaxWindowTimer.Stop();

            batch = [];
            indexedTouched = [];
            classify = mod.OtherCandidateTouched;
            mod.OtherCandidateTouched = false;
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
                    if (plugin.ClassificationArmed) classify = true;
                    if (plugin.IndexedArmed) indexedTouched.Add(plugin);
                    plugin.FileTouched = false;
                }
            }
        }

        if (batch.Count > 0) RaiseSafely(() => ProjectSourceBatch(batch));
        if (classify) RaiseSafely(() => TrackedModSettled.Handle(_holder.Current, mod.ModFolder, _notifications));
        foreach (var plugin in indexedTouched) SettleIndexed(plugin);
    }

    /// <summary>ADR-0015 invariant 2: everything one mod settled together, under one gate
    /// acquisition and one projection scope, so a client that awaits once sees the whole
    /// batch.</summary>
    internal void ProjectSourceBatch(IReadOnlyList<SourceChangeEvent> batch)
    {
        // A closed Index has nowhere for a batch to land, and the next reconcile re-derives whatever
        // settled while it was shut.
        if (_index.Status.State is LoadOrderState.None) return;

        try
        {
            using var _ = _index.WriteGate.Enter();
            using var projection = _index.BeginProjection();
            foreach (var change in batch) ProjectOne(change);
        }
        catch (IndexWriteGateTimeoutException ex)
        {
            // ADR-0019: never swallowed. The timer callback has no caller to propagate to, so the
            // whole batch is logged rather than lost; it is re-checked the same way a single
            // plugin's own catch below re-checks its.
            var plugins = string.Join(", ", batch.Select(c => $"{c.PluginName} ({c.Origin})"));
            _logger.LogWarning(ex,
                "Could not project the source change batch for {Plugins}; it will be re-checked at the " +
                "next signal and at the next reconcile", plugins);
        }
    }

    private void ProjectOne(SourceChangeEvent change)
    {
        var key = new PluginKey(change.PluginName, change.Origin);
        try
        {
            // A mod with no repository is untracked rather than broken: nothing to project from yet,
            // or any more. The registration stands, since Track registers before it writes.
            if (!SourceRepository.IsTracked(change.ModFolder)) return;

            if (change.Scope == SourceChangeScope.Documents && FormKeysOf(change) is { } formKeys)
            {
                _index.RefreshKeys(key, formKeys);
                return;
            }

            ValidateWholeCopy(key);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Could not project the source change to {Plugin} ({Origin}); it will be re-checked at the " +
                "next signal and at the next reconcile", change.PluginName, change.Origin);
        }
    }

    // The answer to a ref move, a dropped event and a burst too wide to name keys for: one git
    // listing for the whole copy, where a per-key refresh asks git per record.
    private void ValidateWholeCopy(PluginKey key)
    {
        foreach (var report in _index.ValidateIndex(key))
        {
            foreach (var failure in report.Failures)
                _logger.LogWarning("Validating {Plugin} after a source change: {Failure}", key.Name, failure);

            // ADR-0014: a re-derived copy has too many rows to name, so this names the plugin.
            // Announced rather than published, so its sequence is the one the batch landed on.
            if (report.NeedsRebuild)
                _index.Announce(() => _notifications.Publish(new PluginChangedNotification(key, _index.Sequence)));
        }
    }

    // Null when any path in the batch names no key: an unknown layout, a document that has gone or one
    // that cannot be read is a whole-plugin question, never a guess.
    private static List<string>? FormKeysOf(SourceChangeEvent change)
    {
        var formKeys = new List<string>();
        foreach (var path in change.Paths)
        {
            if (SourceRepository.CarriesNoRecord(path)) continue;
            if (SourceRepository.FormKeyDeclaredBy(path, change.ModFolder, change.PluginName) is not { } formKey)
                return null;
            formKeys.Add(formKey);
        }
        return formKeys;
    }


    // Content, never events: identical bytes raise nothing, so a touch is free. The remembered hash
    // moves ahead of the projection and is put back on failure only if nothing newer has landed.
    private void SettleIndexed(PluginEntry plugin)
    {
        var pluginPath = plugin.Path!;
        IndexedBinaryEvent settled;
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
                settled = new IndexedBinaryEvent(plugin.Name, plugin.Origin ?? "", IndexedBinaryChange.Deleted);
            }
            else
            {
                if (_index.ContentHashOnDisk(pluginPath) is not { } observed || observed == previousHash) return;
                reportedHash = observed;
                settled = new IndexedBinaryEvent(plugin.Name, plugin.Origin ?? "", IndexedBinaryChange.Modified);
            }

            plugin.RememberedHash = reportedHash;
        }

        if (ProjectIndexedBinary(settled)) return;

        lock (_gate)
        {
            if (plugin.RememberedHash == reportedHash) plugin.RememberedHash = previousHash;
        }
    }

    // ADR-0009's runtime half. Nothing escapes it: it runs on a timer thread where an exception is a
    // process crash, and a false answer puts the remembered hash back.
    private bool ProjectIndexedBinary(IndexedBinaryEvent change)
    {
        var key = new PluginKey(change.PluginName, change.Origin);
        try
        {
            switch (change.Change)
            {
                case IndexedBinaryChange.Modified:
                    if (_logger.IsEnabled(LogLevel.Information))
                    {
                        _logger.LogInformation(
                            "{Plugin} ({Origin}) changed on disk; re-indexing it", change.PluginName, change.Origin);
                    }
                    _index.ReindexPlugin(key).GetAwaiter().GetResult();
                    break;

                case IndexedBinaryChange.Deleted:
                    _index.UnindexPlugin(key);
                    break;
            }

            // ADR-0014: the plugin watcher's own re-index, so the whole plugin changed rather than
            // named rows — the same event Track's own reindex would raise if it went through here.
            _notifications.Publish(new PluginChangedNotification(key, _index.Sequence));
            return true;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex,
                "Could not project the on-disk change to {Plugin} ({Origin}) into the index; it will be retried " +
                "the next time that file settles, and re-checked at the next reconcile",
                change.PluginName, change.Origin);
            return false;
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
        // A path that is neither source, refs nor a registered plugin's own binary — an asset, a
        // meta.ini edit — set mod-wide since the classifier checks git's status, not this flag.
        public bool OtherCandidateTouched { get; set; }
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

internal enum IndexedBinaryChange
{
    Modified,
    Deleted,
}

/// <summary>ADR-0009: one indexed binary's disk event, as the settle observed it.</summary>
internal sealed record IndexedBinaryEvent(string PluginName, string Origin, IndexedBinaryChange Change);

/// <summary>Which projection the batch asks for: the named documents, or the whole copy when a ref
/// moved, the operating system dropped events, or the burst was wider than one batch is worth.</summary>
internal enum SourceChangeScope
{
    Documents,
    WholePlugin,
}

/// <summary>ADR-0014: one settled batch of source changes to one plugin copy.</summary>
internal sealed record SourceChangeEvent(
    string PluginName, string Origin, string ModFolder, SourceChangeScope Scope, IReadOnlyList<string> Paths);
