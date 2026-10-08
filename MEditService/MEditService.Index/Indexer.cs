using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>The record index's Indexer (target-architecture.d2 medit_readmodel.index.indexer): status,
/// filter, rebuild and reads, over the reconcile that fills the Store.</summary>
internal sealed class Indexer : IQueryIndex, IDisposable
{
    private readonly LoadOrderHolder _holder;
    private readonly DuckDbRecordIndexFactory _indexFactory;
    private readonly FilterInForce _filter;
    // One per Indexer, never replaced: a reconcile swaps the store beneath it, which is when the
    // ordering matters most.
    private readonly IndexWriteGate _gate = new();
    private readonly Reconciler _reconciler;

    /// <summary>The registration's door: the Index opens its own store (ADR-0014).</summary>
    public Indexer(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        ISourceAdapter source,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        var logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _filter = new FilterInForce(logger, notifications);
        _indexFactory = new DuckDbRecordIndexFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector), _gate, _filter, notifications,
            loggerFactory?.CreateLogger<DuckDbRecordIndexFactory>(), timeProvider);
        _reconciler = new Reconciler(
            holder, adapter, source, _indexFactory, _filter, logger, notifications, timeProvider ?? TimeProvider.System);
    }

    public LoadOrderStatus Status => _reconciler.Status;

    public long Sequence => _reconciler.Sequence;

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => _reconciler.AwaitSequenceAsync(atLeast, timeout);

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public IRecordReads RequireReads() => _reconciler.RequireReads();

    public IRecordReads RequireWholeSetReads() => _reconciler.RequireWholeSetReads();

    public IReadOnlyList<SourceFileFailure> SourceFileFailures => _reconciler.SourceFileFailures;

    /// <summary>The filter in force and the source its SQL came from, read together so a
    /// concurrent set never pairs one filter's SQL with another's source.</summary>
    public (string Sql, string Source)? ActiveFilter => _filter.Current;

    /// <summary>Throws <see cref="ArgumentException"/> if the SQL does not return a form_key
    /// column.</summary>
    public void SetFilter(string sql, string source) => ApplyFilter((sql, source));

    public void ClearFilter() => ApplyFilter(null);

    private void ApplyFilter((string Sql, string Source)? filter)
    {
        // Materializing the filter is an index write, and the filter box is live while an edit runs, so
        // racing an in-flight edit is the ordinary case: gated like every write.
        using var _ = _gate.Enter();

        if (_reconciler.UnderScope((index, scope) => _filter.Set(index, scope, filter))) return;

        // A filter kept through a rebuild outlives the store it was materialized in.
        if (filter is not null) throw new NoLoadOrderException();
        _filter.Clear();
    }

    /// <summary>ADR-0010: drops the index file, floors its sequence at what this process
    /// handed out, and refills it off the caller's thread; a file another window holds is refused,
    /// and the refusal returned.</summary>
    public string? RebuildStore(GameRelease gameRelease, string instanceRoot)
    {
        var previousSequence = Sequence;
        _reconciler.Close();
        if (_indexFactory.Rebuild(gameRelease, instanceRoot, previousSequence) is { } refusal) return refusal;
        _reconciler.StartReconcile();
        return null;
    }

    public void Subscribe() => _holder.Arrived += OnArrived;

    private void OnArrived(LoadOrderSnapshot snapshot, long version) => _reconciler.StartReconcile();

    public void Dispose()
    {
        _holder.Arrived -= OnArrived;
        _reconciler.Dispose();
    }
}
