namespace MEditService.LoadOrder;

/// <summary>Where the shared kernel keeps the current load order. The put-load-order and
/// create-plugin handlers are the only callers of <see cref="Apply"/> (ADR-0013 invariant 1: one
/// arrival); everything else reads Current.</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous value whole rather
    // than a half-applied one.
    private LoadOrderSnapshot _current = LoadOrderSnapshot.Empty;
    private long _version;

    public LoadOrderSnapshot Current => Volatile.Read(ref _current);

    /// <summary>The version of the last Apply, for a caller waiting until nothing is still
    /// reconciling — a status poll needs this to know which arrival is the latest.</summary>
    public long Version => Volatile.Read(ref _version);

    /// <summary>Every reader of a snapshot change subscribes here, wired at composition. Carries
    /// this Apply's own version, so a subscriber and its caller name the same arrival.</summary>
    public event Action<LoadOrderSnapshot, long>? Changed;

    /// <summary>One higher per Apply that changes the load order, for a caller asking whether the
    /// Index has reconciled it yet. A snapshot equal to the current one is a no-op (ADR-0013
    /// invariant 1) and answers the current version.</summary>
    public long Apply(LoadOrderSnapshot snapshot)
    {
        if (snapshot.Equals(Current)) return Version;
        var version = Interlocked.Increment(ref _version);
        Volatile.Write(ref _current, snapshot);
        Changed?.Invoke(snapshot, version);
        return version;
    }

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrderSnapshot Require() =>
        Current is { DataFolderPath.Length: > 0 } current ? current : throw new NoLoadOrderException();
}
