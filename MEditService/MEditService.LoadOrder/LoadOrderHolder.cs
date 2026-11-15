namespace MEditService.LoadOrder;

/// <summary>Where the shared kernel keeps the current load order (ADR-0013).</summary>
public sealed class LoadOrderHolder
{
    // Replaced wholesale, never mutated, so a reader mid-Apply sees the previous arrival whole: its
    // snapshot and its version together, never one without the other.
    private Arrival _held = new(LoadOrderSnapshot.Empty, 0);
    private readonly Lock _applying = new();
    private long _sourceWrites;

    public LoadOrderSnapshot Current => Volatile.Read(ref _held).Snapshot;

    /// <summary>The snapshot held and the version it arrived as, read together; null before any
    /// snapshot has arrived.</summary>
    public (LoadOrderSnapshot Snapshot, long Version)? Held =>
        Volatile.Read(ref _held) is { Snapshot.DataFolderPath.Length: > 0 } held ? (held.Snapshot, held.Version) : null;

    /// <summary>Raised by every Apply, changed or not (ADR-0013). Carries the version
    /// Apply answers.</summary>
    public event Action<LoadOrderSnapshot, long>? Arrived;

    /// <summary>How many times mEdit has written a system of record. A write waits for the record index to
    /// have read what it wrote.</summary>
    public long SourceWrites => Interlocked.Read(ref _sourceWrites);

    private readonly Lock _writing = new();
    private readonly AsyncLocal<OwnWrites?> _ownWrites = new();

    /// <summary>Raised by every SourceWritten with the plugins it names and the count it was given, in the order of the
    /// counts: a write counted is raised before the next is counted.</summary>
    public event Action<IReadOnlyCollection<PluginChange>?, long>? Written;

    /// <summary>From here, the writes counted by this flow of execution and the ones it starts, as they are counted.</summary>
    public OwnWrites BeginOwnWrites()
    {
        OwnWrites own = new();
        _ownWrites.Value = own;
        return own;
    }

    /// <summary>Marks that mEdit wrote a system of record, of <paramref name="written"/>; null when no plugin names
    /// what it wrote.</summary>
    public void SourceWritten(IReadOnlyCollection<PluginChange>? written)
    {
        lock (_writing)
        {
            var write = Interlocked.Increment(ref _sourceWrites);
            _ownWrites.Value?.Add(new SourceWrite(write, written?.Select(change => change.Plugin).ToList()));
            Written?.Invoke(written, write);
        }
    }

    /// <summary>One higher per Apply that changes the load order, for a caller asking whether the
    /// Index has reconciled it. An equal snapshot answers the current version.</summary>
    public long Apply(LoadOrderSnapshot snapshot)
    {
        Arrival arrival;
        lock (_applying)
        {
            arrival = _held;
            if (!snapshot.Equals(arrival.Snapshot)) arrival = new Arrival(snapshot, arrival.Version + 1);
            Volatile.Write(ref _held, arrival);
        }
        Arrived?.Invoke(arrival.Snapshot, arrival.Version);
        return arrival.Version;
    }

    /// <summary>The value a read must have. The one place a read refuses for want of a load order:
    /// no snapshot has a data folder to name, so an empty one means none has arrived.</summary>
    public LoadOrderSnapshot Require() => Held?.Snapshot ?? throw new NoLoadOrderException();

    private sealed record Arrival(LoadOrderSnapshot Snapshot, long Version);
}

/// <summary>The writes one flow of execution counted, so a gesture waits for its own and no other.</summary>
public sealed class OwnWrites
{
    private readonly List<SourceWrite> _writes = [];

    internal OwnWrites()
    {
    }

    internal void Add(SourceWrite write)
    {
        lock (_writes) _writes.Add(write);
    }

    public IReadOnlyList<SourceWrite> Snapshot()
    {
        lock (_writes) return [.. _writes];
    }
}

/// <summary>A write of mEdit's, by its count, and the plugins it named; null when none did, which only a check of the
/// whole disk reads.</summary>
public sealed record SourceWrite(long Count, IReadOnlyList<PluginAddress>? Plugins);

/// <summary>A plugin a change touched, and the files of it the change names; null when it cannot tell which, so every file
/// of the plugin is read again (ADR-0001).</summary>
public sealed record PluginChange(PluginAddress Plugin, IReadOnlyList<string>? Files);
