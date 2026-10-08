using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Index;

/// <summary>ADR-0014: the Index's other half (target-architecture.d2 medit_readmodel.index.indexer).
/// The face Queries sees: status, filter, rebuild and reads, over the reconcile that fills the Store.</summary>
internal sealed class Indexer : IQueryIndex, IDisposable
{
    private readonly LoadOrderHolder _holder;
    private readonly DuckDbRecordIndexFactory _indexFactory;
    private readonly FilterInForce _filter;
    private readonly Reconciler _reconciler;

    /// <summary>The registration's door: the Index opens its own store (ADR-0014).</summary>
    public Indexer(
        LoadOrderHolder holder,
        IPluginAdapter adapter,
        SchemaReflector schemaReflector,
        ILoggerFactory? loggerFactory = null,
        INotificationPublisher? notifications = null,
        TimeProvider? timeProvider = null)
    {
        _holder = holder;
        var logger = loggerFactory?.CreateLogger<Indexer>() ?? NullLogger<Indexer>.Instance;
        _indexFactory = new DuckDbRecordIndexFactory(
            schemaReflector, new TableDdlBuilder(schemaReflector),
            loggerFactory?.CreateLogger<DuckDbRecordIndexFactory>(), timeProvider);
        _filter = new FilterInForce(logger, notifications);
        _reconciler = new Reconciler(
            holder, adapter, _indexFactory, _filter, logger, notifications, timeProvider ?? TimeProvider.System);
    }

    public LoadOrderStatus Status => _reconciler.Status;

    public long Sequence => _reconciler.Sequence;

    public Task<bool> AwaitSequenceAsync(long atLeast, TimeSpan timeout) => _reconciler.AwaitSequenceAsync(atLeast, timeout);

    /// <summary>Throws <see cref="NoLoadOrderException"/>, never null: before the first reconcile
    /// the Index has opened no store to read.</summary>
    public IRecordReads RequireReads() => _reconciler.RequireReads();

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
        using var _ = _reconciler.WriteGate.Enter();

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
        // Released before the reconcile below opens the same file for its own scope.
        using (var rebuilt = _indexFactory.Rebuild(gameRelease, instanceRoot, previousSequence, out var refusal))
        {
            if (rebuilt is null) return refusal;
        }
        _ = _reconciler.StartReconcile();
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
