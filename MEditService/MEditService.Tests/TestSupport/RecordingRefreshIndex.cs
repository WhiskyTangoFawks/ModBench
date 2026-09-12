using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;

namespace MEditService.Tests.TestSupport;

/// <summary>What the watcher asked the Index for, in order, with the projection scope it was inside
/// and how long after the recorder started.</summary>
internal sealed record RecordedProjection(
    string Verb, PluginKey? Plugin, IReadOnlyList<string> Keys, int Scope, TimeSpan At);

/// <summary>The Index as a recorder: the watcher's routing is what it asked for, so a test reads the
/// verb and the copy rather than the delegate that carried it.</summary>
internal sealed class RecordingRefreshIndex : IRefreshIndex
{
    private readonly object _gate = new();
    private readonly List<RecordedProjection> _projections = [];
    private readonly System.Diagnostics.Stopwatch _since = System.Diagnostics.Stopwatch.StartNew();
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

    public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys)
    {
        Refuse();
        Record("refresh", key, formKeys);
    }

    public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin)
    {
        Refuse();
        Record("validate", plugin, []);
        return [];
    }

    public Task ReindexPlugin(PluginKey key)
    {
        Record("reindex", key, []);
        Refuse();
        return Task.CompletedTask;
    }

    public void UnindexPlugin(PluginKey key)
    {
        Record("unindex", key, []);
        Refuse();
    }

    // No rows for any copy: the recorder is a listener, never a store with a baseline to compare.
    public string? IndexedContentHash(PluginKey key) => null;

    // The real hash of the real file: the watcher's binary settle is about the bytes on disk, and a
    // recorder that invented one would decide the test's outcome.
    public string? ContentHashOnDisk(string pluginPath) =>
        File.Exists(pluginPath)
            ? Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(pluginPath)))
            : null;

    private void Refuse()
    {
        if (Refuses) throw new NoLoadOrderException();
    }

    private void Record(string verb, PluginKey? plugin, IReadOnlyList<string> keys)
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
