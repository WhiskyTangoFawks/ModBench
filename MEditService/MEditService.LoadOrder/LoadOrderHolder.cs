namespace MEditService.LoadOrder;

/// <summary>Where the shared kernel keeps the current load order (ADR-0013 invariant 4).</summary>
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

    /// <summary>Raised by every Apply, changed or not (ADR-0013 invariant 1). Carries the version
    /// Apply answers.</summary>
    public event Action<LoadOrderSnapshot, long>? Arrived;

    /// <summary>One higher per Apply that changes the load order, for a caller asking whether the
    /// Index has reconciled it. An equal snapshot answers the current version.</summary>
    public long Apply(LoadOrderSnapshot snapshot)
    {
        Arrival arrival;
        lock (_applying)
        {
            arrival = _held;
            if (!snapshot.Equals(arrival.Snapshot))
            {
                arrival = new Arrival(snapshot, arrival.Version + 1);
                Volatile.Write(ref _held, arrival);
            }
        }
        Arrived?.Invoke(arrival.Snapshot, arrival.Version);
        return arrival.Version;
    }

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrderSnapshot Require() => Held?.Snapshot ?? throw new NoLoadOrderException();

    private sealed record Arrival(LoadOrderSnapshot Snapshot, long Version);
}
