using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Tests.TestSupport;

/// <summary>What the watcher asked the Index for, in order, with the projection scope it was inside
/// and how long after the recorder started.</summary>
internal sealed record RecordedProjection(
    string Verb, PluginCopyKey? Plugin, IReadOnlyList<string> Keys, int Scope, TimeSpan At);

/// <summary>The Index as a recorder: the watcher's routing is what it asked for, so a test reads the
/// verb and the copy rather than the delegate that carried it.</summary>
internal sealed class RecordingRefreshIndex : IRefreshIndex
{
    private readonly object _gate = new();
    private readonly List<RecordedProjection> _projections = [];
    private readonly System.Diagnostics.Stopwatch _since = System.Diagnostics.Stopwatch.StartNew();
    private readonly Dictionary<PluginCopyKey, string> _indexedHashes = new(PluginCopyKey.Comparer);
    private int _scope;

    public IndexWriteGate WriteGate { get; init; } = new();

    public LoadOrderStatus Status { get; } =
        new(LoadOrderState.Ready, 0, [], ConflictsComputed: true, []);

    public long Sequence => 0;

    /// <summary>Makes the index refuse the way a torn-down load order does, so the watcher's own
    /// answer to a projection it could not land is observable.</summary>
    public bool Refuses { get; set; }

    public IReadOnlyList<RecordedProjection> Projections
    {
        get { lock (_gate) return [.. _projections]; }
    }

    public IReadOnlyList<RecordedProjection> Of(string verb) =>
        [.. Projections.Where(p => p.Verb == verb)];

    public IDisposable BeginProjection()
    {
        lock (_gate)
        {
            _scope++;
            Record("projection", null, []);
            return new Scope();
        }
    }

    public void Announce(Action publish) => publish();

    public void RefreshKeys(PluginCopyKey key, IReadOnlyList<string> formKeys)
    {
        Refuse();
        Record("refresh", key, formKeys);
    }

    public IReadOnlyList<ValidationReport> ValidateIndex(PluginCopyKey? plugin)
    {
        Refuse();
        Record("validate", plugin, []);
        return [];
    }

    /// <summary>Seeds this copy as already indexed with this hash — the state a prior reconcile
    /// would have left, for a test that arranges "already indexed" before watching.</summary>
    public void SeedIndexed(PluginCopyKey key, string hash) => _indexedHashes[key] = hash;

    public Task<bool> RefreshBinary(PluginCopyKey key, string path)
    {
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

    private void Record(string verb, PluginCopyKey? plugin, IReadOnlyList<string> keys)
    {
        lock (_gate) _projections.Add(new RecordedProjection(verb, plugin, keys, _scope, _since.Elapsed));
    }

    // The scope number only has to distinguish one batch's projections from the next batch's, which
    // BeginProjection already advanced; closing it is nothing the recorder has to observe.
    private sealed class Scope : IDisposable
    {
        public void Dispose() { }
    }
}
