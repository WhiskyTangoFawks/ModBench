namespace MEditService.LoadOrder;

/// <summary>Where the shared kernel keeps the current load order. The put-load-order and
/// create-plugin handlers are the only callers of <see cref="Apply"/> (ADR-0013 invariant 1: one
/// arrival); everything else reads Current.</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous arrival whole: its
    // snapshot and its version together, never one without the other.
    private Arrival _held = new(LoadOrderSnapshot.Empty, 0);
    private readonly Lock _applying = new();

    public LoadOrderSnapshot Current => Volatile.Read(ref _held).Snapshot;

    /// <summary>The version of the last Apply, for a caller waiting until nothing is still
    /// reconciling — a status poll needs this to know which arrival is the latest.</summary>
    public long Version => Volatile.Read(ref _held).Version;

    /// <summary>The snapshot held and the version it arrived as, read together; null before any
    /// snapshot has arrived.</summary>
    public (LoadOrderSnapshot Snapshot, long Version)? Held =>
        Volatile.Read(ref _held) is { Snapshot.DataFolderPath.Length: > 0 } held ? (held.Snapshot, held.Version) : null;

    /// <summary>Every reader of a snapshot change subscribes here, wired at composition. Carries
    /// this Apply's own version, so a subscriber and its caller name the same arrival.</summary>
    public event Action<LoadOrderSnapshot, long>? Changed;

    /// <summary>One higher per Apply that changes the load order, for a caller asking whether the
    /// Index has reconciled it. An equal snapshot is a no-op (ADR-0013 invariant 1), answering the
    /// current version.</summary>
    public long Apply(LoadOrderSnapshot snapshot)
    {
        Arrival next;
        lock (_applying)
        {
            var held = _held;
            if (snapshot.Equals(held.Snapshot)) return held.Version;
            next = new Arrival(snapshot, held.Version + 1);
            Volatile.Write(ref _held, next);
        }
        Changed?.Invoke(next.Snapshot, next.Version);
        return next.Version;
    }

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrderSnapshot Require() => Held?.Snapshot ?? throw new NoLoadOrderException();

    private sealed record Arrival(LoadOrderSnapshot Snapshot, long Version);
}
