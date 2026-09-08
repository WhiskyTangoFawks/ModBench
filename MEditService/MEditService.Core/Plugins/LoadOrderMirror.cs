using MEditService.Core.Notifications;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;

namespace MEditService.Core.Plugins;

/// <summary>See <see cref="ILoadOrderMirror"/>. Delegation only: the Index's projector holds the
/// store and every projection (ADR-0046 invariant 10), and this type is the seam the write side is
/// still handed until it moves onto the projector.</summary>
public sealed class LoadOrderMirror : ILoadOrderMirror, IDisposable
{
    private readonly IndexProjector _projector;

    public LoadOrderMirror(
        IRecordIndexFactory indexFactory,
        ILogger<LoadOrderMirror>? logger = null,
        IModImporter? modImporter = null,
        SchemaReflector? schemaReflector = null,
        INotificationPublisher? notifications = null)
        : this(new IndexProjector(indexFactory, logger, modImporter, schemaReflector, notifications))
    {
    }

    /// <summary>The composition root's door: the Index is what is registered, and this shell wraps
    /// that one instance, so the write side and the read side never project into two stores.</summary>
    public LoadOrderMirror(IndexProjector projector) => _projector = projector;

    /// <summary>The Index this wraps, for a caller holding a mirror that needs to hand the Index
    /// itself to a read-side collaborator.</summary>
    public IndexProjector Projector => _projector;

    public ILoadOrder? LoadOrder => _projector.LoadOrder;
    public IRecordReads? Reads => _projector.Reads;
    public IRecordIndex? Index => _projector.Index;
    public IndexWriteGate WriteGate => _projector.WriteGate;
    public LoadOrderStatus Status => _projector.Status;
    public long Sequence => _projector.Sequence;

    public Action? LoadOrderChanged
    {
        get => _projector.LoadOrderChanged;
        set => _projector.LoadOrderChanged = value;
    }

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) =>
        _projector.AwaitSequenceAsync(atLeast, timeout);

    public IDisposable BeginProjection() => _projector.BeginProjection();

    public void Announce(Action publish) => _projector.Announce(publish);

    public (ILoadOrder LoadOrder, IRecordReads Reads) RequireScope() => _projector.RequireScope();

    /// <summary>The snapshot becomes the load order value here, through the same
    /// <see cref="Plugins.LoadOrder.From(string, string?, GameRelease, IReadOnlyList{LoadOrderEntry})"/>
    /// door the endpoint applies to the shared kernel.</summary>
    public void Reconcile(
        string gameDirectory, IReadOnlyList<LoadOrderEntry> plugins, GameRelease gameRelease,
        string? instanceRoot = null) =>
        _projector.Reconcile(Plugins.LoadOrder.From(gameDirectory, instanceRoot, gameRelease, plugins));

    public void Close() => _projector.Close();

    public PluginResponse CreatePlugin(string name, string path, string origin) =>
        _projector.CreatePlugin(name, path, origin);

    public IReadOnlyList<ValidationReport> ValidateIndex(PluginKey? plugin) => _projector.ValidateIndex(plugin);

    public void RefreshKeys(PluginKey key, IReadOnlyList<string> formKeys) => _projector.RefreshKeys(key, formKeys);

    public Task ReindexPlugin(PluginKey key) => _projector.ReindexPlugin(key);

    public void UnindexPlugin(PluginKey key) => _projector.UnindexPlugin(key);

    public void SetFilter(string sql) => _projector.SetFilter(sql);

    public void ClearFilter() => _projector.ClearFilter();

    public void Dispose() => _projector.Dispose();
}
