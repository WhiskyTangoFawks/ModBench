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

    /// <summary>How many times mEdit has written a system of record. A read after a write waits for the record index to
    /// have read what it wrote.</summary>
    public long SourceWrites => Interlocked.Read(ref _sourceWrites);

    private readonly Lock _writing = new();
    private readonly Dictionary<PluginAddress, long> _lastWriteOf = new(PluginAddress.Comparer);
    private long _lastUnnamedWrite;

    /// <summary>Raised by every SourceWritten, once it is counted, with the plugins it names.</summary>
    public event Action<IReadOnlyCollection<PluginWritten>?>? Written;

    /// <summary>Marks that mEdit wrote a system of record, of <paramref name="written"/>; null when no plugin names
    /// what it wrote.</summary>
    public void SourceWritten(IReadOnlyCollection<PluginWritten>? written)
    {
        lock (_writing)
        {
            var write = Interlocked.Increment(ref _sourceWrites);
            if (written is null) _lastUnnamedWrite = write;
            else foreach (var plugin in written) _lastWriteOf[plugin.Plugin] = write;
        }
        Written?.Invoke(written);
    }

    /// <summary>Of the writes after <paramref name="checkedThrough"/>, the last that named no plugin, which only a check of
    /// the whole disk reads, or 0 when none did; and each plugin's last.</summary>
    public (long LastUnnamed, IReadOnlyDictionary<PluginAddress, long> LastOfEach) WritesAfter(long checkedThrough)
    {
        lock (_writing)
        {
            return (_lastUnnamedWrite > checkedThrough ? _lastUnnamedWrite : 0,
                _lastWriteOf.Where(last => last.Value > checkedThrough).ToDictionary(PluginAddress.Comparer));
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

/// <summary>A plugin a write changed, and the files of its source the write names; null when it cannot tell which, so every
/// file of the plugin is read again (ADR-0001).</summary>
public sealed record PluginWritten(PluginAddress Plugin, IReadOnlyList<string>? Files);
