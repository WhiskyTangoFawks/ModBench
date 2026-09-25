using MEditService.LoadOrder;
using MEditService.SourceAdapter;

namespace MEditService.Watcher;

/// <summary>A tracked mod the snapshot holds, with every plugin it holds there: what the load-time
/// settle reads and classifies.</summary>
internal sealed record TrackedMod(string ModFolder, IReadOnlyList<RegisteredPlugin> Plugins);

/// <summary>Arming from the snapshot: one watch per folder the load order names, tracked or not,
/// and none for a folder outside it. Re-armed whole on every change (ADR-0013 invariant 1).</summary>
internal sealed class WatchSet : IDisposable
{
    private readonly object _gate = new();
    private readonly Dictionary<string, ModWatch> _mods = new(StringComparer.Ordinal);
    private readonly TimeSpan _quiet;
    private readonly TimeSpan _maxWindow;
    private readonly TimeProvider _time;
    private readonly Action<ModWatch> _settle;
    private readonly Action<ModWatch> _overflow;
    private long? _armedVersion;
    private bool _disposed;

    public WatchSet(TimeSpan quiet, TimeSpan maxWindow, TimeProvider time, Action<ModWatch> settle, Action<ModWatch> overflow)
    {
        _quiet = quiet;
        _maxWindow = maxWindow;
        _time = time;
        _settle = settle;
        _overflow = overflow;
    }

    /// <summary>The watch set this snapshot implies. Null when a newer version was armed already
    /// or the set is disposed: that change arms nothing and settles nothing.</summary>
    public IReadOnlyList<TrackedMod>? Arm(LoadOrderSnapshot order, long version)
    {
        var wanted = FoldersOf(order);
        var tracked = new List<TrackedMod>();

        lock (_gate)
        {
            // A change already past the watcher's in-flight gate when Dispose ran would otherwise
            // arm watches nothing disposes.
            if (_disposed) return null;
            if (_armedVersion is { } armed && version <= armed) return null;
            _armedVersion = version;

            // A watch must never outlive the load order that asked for it, or a copy outside the
            // load order would keep settling into the Index and Commands.
            foreach (var folder in _mods.Keys.Where(f => !wanted.ContainsKey(f)).ToList())
            {
                _mods[folder].Dispose();
                _mods.Remove(folder);
            }

            foreach (var (folder, mod) in wanted)
            {
                var isTracked = mod.Trackable && SourceRepository.IsTracked(folder);
                if (WatchOf(folder, recursive: isTracked, upgradable: mod.Trackable) is not { } watch) continue;

                watch.ClearRegistrations();
                foreach (var copy in mod.Copies) watch.Register(copy.Name, copy.Origin, copy.Path);
                if (isTracked)
                {
                    watch.EnsureRecursive();
                    tracked.Add(new TrackedMod(folder, mod.Copies));
                }
            }
        }

        return tracked;
    }

    /// <summary>Drops the watch on a folder that is gone from disk. Nothing re-arms it until the
    /// next load-order change names it again.</summary>
    public void Drop(ModWatch watch)
    {
        lock (_gate)
        {
            if (_mods.Remove(watch.ModFolder)) watch.Dispose();
        }
    }

    // The game's own Data folder is never a tracked mod (Track does not apply there), and never
    // recursive: it can hold thousands of files and has no source tree or refs to answer for.
    private static Dictionary<string, (bool Trackable, List<RegisteredPlugin> Copies)> FoldersOf(LoadOrderSnapshot order)
    {
        var folders = new Dictionary<string, (bool Trackable, List<RegisteredPlugin> Copies)>(StringComparer.Ordinal);
        foreach (var copy in order.Plugins)
        {
            var modFolder = LoadOrderSnapshot.ModFolderOf(copy.Origin, copy.Path);
            var folder = modFolder ?? Path.GetDirectoryName(copy.Path)
                ?? throw new ArgumentException($"'{copy.Path}' has no containing directory.", nameof(order));
            if (!folders.TryGetValue(folder, out var entry))
                folders[folder] = entry = (modFolder is not null, []);
            entry.Copies.Add(copy);
        }
        return folders;
    }

    // Called under _gate. Lazily arms the folder's watch, recursive only once needed. A vanished
    // mod folder gets no watch, and no throw.
    private ModWatch? WatchOf(string folder, bool recursive, bool upgradable)
    {
        if (_mods.TryGetValue(folder, out var existing)) return existing;
        try
        {
            var watch = new ModWatch(folder, recursive, upgradable, _quiet, _maxWindow, _time, _settle, _overflow);
            _mods[folder] = watch;
            return watch;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            _disposed = true;
            foreach (var mod in _mods.Values) mod.Dispose();
            _mods.Clear();
        }
    }
}
