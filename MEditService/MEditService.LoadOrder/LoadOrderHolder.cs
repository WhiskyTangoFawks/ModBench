namespace MEditService.LoadOrder;

/// <summary>Where the shared kernel keeps the current load order (ADR-0013).</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous arrival whole: its
    // snapshot and its version together, never one without the other.
    private Arrival _held = new(LoadOrderSnapshot.Empty, 0, 0);
    private readonly Lock _applying = new();
    private long _arrivalAwaited;

    public LoadOrderSnapshot Current => Volatile.Read(ref _held).Snapshot;

    /// <summary>The snapshot held and the version it arrived as, read together; null before any
    /// snapshot has arrived.</summary>
    public (LoadOrderSnapshot Snapshot, long Version)? Held =>
        Volatile.Read(ref _held) is { Snapshot.DataFolderPath.Length: > 0 } held ? (held.Snapshot, held.Version) : null;

    /// <summary>Raised by every Apply, changed or not (ADR-0013). Carries the version
    /// Apply answers.</summary>
    public event Action<LoadOrderSnapshot, long>? Arrived;

    /// <summary>How many snapshots have arrived, changed or not.</summary>
    public long Arrivals => Volatile.Read(ref _held).Count;

    /// <summary>The arrival a read waits for the Index to have reconciled: the one after the last source write, whose
    /// change reaches the Index only through the next snapshot (ADR-0015).</summary>
    public long ArrivalAwaited => Interlocked.Read(ref _arrivalAwaited);

    /// <summary>Marks that mEdit wrote a system of record after every arrival so far.</summary>
    public void SourceWritten()
    {
        lock (_applying) Interlocked.Exchange(ref _arrivalAwaited, _held.Count + 1);
    }

    /// <summary>One higher per Apply that changes the load order, for a caller asking whether the
    /// Index has reconciled it. An equal snapshot answers the current version.</summary>
    public long Apply(LoadOrderSnapshot snapshot)
    {
        Arrival arrival;
        lock (_applying)
        {
            arrival = _held;
            arrival = snapshot.Equals(arrival.Snapshot)
                ? arrival with { Count = arrival.Count + 1 }
                : new Arrival(snapshot, arrival.Version + 1, arrival.Count + 1);
            Volatile.Write(ref _held, arrival);
        }
        Arrived?.Invoke(arrival.Snapshot, arrival.Version);
        return arrival.Version;
    }

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrderSnapshot Require() => Held?.Snapshot ?? throw new NoLoadOrderException();

    private sealed record Arrival(LoadOrderSnapshot Snapshot, long Version, long Count);
}
