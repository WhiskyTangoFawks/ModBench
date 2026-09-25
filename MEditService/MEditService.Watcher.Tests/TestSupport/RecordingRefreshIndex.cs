using MEditService.Index;
using MEditService.LoadOrder;

namespace MEditService.Watcher.Tests.TestSupport;

/// <summary>What the watcher asked the Index for, in order, with the projection scope it was
/// inside.</summary>
internal sealed record RecordedProjection(
    string Verb, PluginAddress? Plugin, IReadOnlyList<string> Keys, int Scope);

/// <summary>The Index as a recorder: the watcher's routing is what it asked for, so a test reads the
/// verb and the plugin rather than the delegate that carried it.</summary>
internal sealed class RecordingRefreshIndex(IndexWriteGate? writeGate = null) : IRefreshIndex
{
    private readonly object _gate = new();
    private readonly List<RecordedProjection> _projections = [];
    private readonly List<(LoadOrderSnapshot Snapshot, long Version)> _reconciles = [];
    private readonly List<(PluginAddress Key, string Path)> _binaryPokes = [];
    private readonly Dictionary<PluginAddress, string> _indexedHashes = new(PluginAddress.Comparer);
    private int _scope;

    public IndexWriteGate WriteGate { get; } = writeGate ?? new IndexWriteGate();

    /// <summary>Closed the way a torn-down load order leaves the store: a batch settling after that
    /// has nowhere to land.</summary>
    public bool Closed { get; set; }

    /// <summary>Makes the index refuse the way a torn-down load order does, so the watcher's own
    /// answer to a projection it could not land is observable.</summary>
    public bool Refuses { get; set; }

    /// <summary>Fails the way a store that cannot open a scope does, so the watcher's answer to a
    /// callback it cannot complete is observable.</summary>
    public bool RefusesProjectionScope { get; set; }

    /// <summary>Set, a validate blocks until it is signalled: the shape of a sink still running
    /// when the watcher is told to go.</summary>
    public ManualResetEventSlim? HoldsValidateUntil { get; set; }

    public IReadOnlyList<RecordedProjection> Projections
    {
        get { lock (_gate) return [.. _projections]; }
    }

    public IReadOnlyList<RecordedProjection> Of(string verb) =>
        [.. Projections.Where(p => p.Verb == verb)];

    /// <summary>Every reconcile the watcher asked for, in order, with the version it named.</summary>
    public IReadOnlyList<(LoadOrderSnapshot Snapshot, long Version)> Reconciles
    {
        get { lock (_gate) return [.. _reconciles]; }
    }

    /// <summary>Every binary poke, whether or not the bytes turned out to differ: what the watcher
    /// asked for is its own fact, where the answer is this recorder's.</summary>
    public IReadOnlyList<(PluginAddress Key, string Path)> BinaryPokes
    {
        get { lock (_gate) return [.. _binaryPokes]; }
    }

    public IDisposable BeginProjection()
    {
        if (RefusesProjectionScope) throw new InvalidOperationException("the store could not open a scope");
        lock (_gate)
        {
            _scope++;
            Record("projection", null, []);
            return new Scope();
        }
    }

    public void Reconcile(LoadOrderSnapshot snapshot, long version)
    {
        lock (_gate) _reconciles.Add((snapshot, version));
    }

    public void RefreshKeys(PluginAddress key, IReadOnlyList<string> formKeys)
    {
        Refuse();
        Record("refresh", key, formKeys);
    }

    public IReadOnlyList<ValidationReport> ValidateIndex(PluginAddress? plugin)
    {
        Refuse();
        HoldsValidateUntil?.Wait(TimeSpan.FromSeconds(30));
        Record("validate", plugin, []);
        return [];
    }

    /// <summary>Seeds this plugin as already indexed with this hash — the state a prior reconcile
    /// would have left, for a test that arranges "already indexed" before watching.</summary>
    public void SeedIndexed(PluginAddress key, string hash) => _indexedHashes[key] = hash;

    public Task<bool> RefreshBinary(PluginAddress key, string path)
    {
        lock (_gate) _binaryPokes.Add((key, path));

        if (!File.Exists(path))
        {
            Record("unindex", key, []);
            Refuse();
            _indexedHashes.Remove(key);
            return Task.FromResult(true);
        }

        var onDisk = ContentHashOnDisk(path);
        if (_indexedHashes.TryGetValue(key, out var indexed) && indexed == onDisk) return Task.FromResult(false);

        Record("reindex", key, []);
        Refuse();
        // Advanced only past the refusal above: a refused write must not leave the recorder
        // believing bytes it never actually landed are now indexed.
        _indexedHashes[key] = onDisk
            ?? throw new InvalidOperationException($"Expected '{path}' to exist once reindexed.");
        return Task.FromResult(true);
    }

    // The real hash of the real file: the watcher's binary settle is about the bytes on disk, and a
    // recorder that invented one would decide the test's outcome.
    private static string? ContentHashOnDisk(string pluginPath) =>
        File.Exists(pluginPath)
            ? Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(pluginPath)))
            : null;

    private void Refuse()
    {
        if (Refuses) throw new NoLoadOrderException();
    }

    private void Record(string verb, PluginAddress? plugin, IReadOnlyList<string> keys)
    {
        lock (_gate) _projections.Add(new RecordedProjection(verb, plugin, keys, _scope));
    }

    // The scope number only has to distinguish one batch's projections from the next batch's, which
    // BeginProjection already advanced; closing it is nothing the recorder has to observe.
    private sealed class Scope : IDisposable
    {
        public void Dispose() { }
    }
}
