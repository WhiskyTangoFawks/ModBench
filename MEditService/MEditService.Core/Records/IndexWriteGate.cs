namespace MEditService.Core.Records;

/// <summary>The one gate every index write passes through; reads never take it. A reentrant
/// <see cref="Lock"/>, not a SemaphoreSlim, because doors nest on the ordinary path. Always taken
/// outside <c>IndexProjector._lock</c>, never inside.</summary>
public sealed class IndexWriteGate(TimeSpan? timeout = null)
{
    // On one DuckDBConnection a second BeginTransaction throws and an unwrapped statement joins the
    // other caller's transaction, dying with its rollback. Reads skip the gate: listing during an
    // edit is the ordinary case and must not queue behind it.

    /// <summary>Long enough that no legitimate write hits it (a whole-plugin re-derivation is tens of
    /// seconds on a large plugin), short enough that a stuck one is reported rather than hung on.</summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(2);

    private readonly Lock _gate = new();
    private readonly TimeSpan _timeout = timeout ?? DefaultTimeout;

    public TimeSpan Timeout => _timeout;

    /// <summary>Throws <see cref="IndexWriteGateTimeoutException"/> rather than returning false: every
    /// caller's answer is the same (do not write), and a boolean would let one forget.</summary>
    public Holding Enter()
    {
        if (!_gate.TryEnter(_timeout)) throw new IndexWriteGateTimeoutException(_timeout);
        return new Holding(_gate);
    }

    /// <summary>One acquisition of the gate; disposing it releases exactly that one.</summary>
    public readonly struct Holding(Lock gate) : IDisposable
    {
        public void Dispose() => gate.Exit();
    }
}

/// <summary>A projection waited out the gate. It reaches no client: a record gesture never takes
/// the gate (ADR-0015 invariant 2), and the source watcher's batch logs it rather than
/// propagating (ADR-0019).</summary>
public sealed class IndexWriteGateTimeoutException : TimeoutException
{
    private const string DefaultMessage = "Another write to the record index is still in progress.";

    // RCS1194: the three standard constructors are required under TreatWarningsAsErrors.
    public IndexWriteGateTimeoutException() : base(DefaultMessage)
    {
    }

    public IndexWriteGateTimeoutException(string message) : base(message)
    {
    }

    public IndexWriteGateTimeoutException(string message, Exception innerException)
        : base(message, innerException)
    {
    }

    public IndexWriteGateTimeoutException(TimeSpan timeout)
        : base($"Another write to the record index is still in progress after {timeout.TotalSeconds:0.###}s.")
    {
        Timeout = timeout;
    }

    /// <summary>How long this caller waited.</summary>
    public TimeSpan Timeout { get; }
}
