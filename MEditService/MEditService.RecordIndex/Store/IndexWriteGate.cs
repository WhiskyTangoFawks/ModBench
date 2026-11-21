namespace MEditService.RecordIndex.Store;

/// <summary>The one gate every index write passes through, and a read a write bakes into a file. A reentrant
/// <see cref="Lock"/>, as doors nest. Taken outside <c>Indexer._lock</c>, never inside.</summary>
internal sealed class IndexWriteGate
{
    // On one DuckDBConnection a second BeginTransaction throws and an unwrapped statement joins the
    // other caller's transaction, dying with its rollback. A view's read skips the gate: it must not
    // queue behind an edit.

    /// <summary>Long enough that no legitimate write hits it (a whole-plugin re-derivation is tens of
    /// seconds on a large plugin), short enough that a stuck one is reported rather than hung on.</summary>
    public static readonly TimeSpan HoldLimit = TimeSpan.FromMinutes(2);

    internal static string NotDrained(string outcome, string consequence) =>
        $"{outcome}: a read of it was still open after {HoldLimit.TotalSeconds:0}s. {consequence}";

    private readonly Lock _gate = new();

    /// <summary>Throws <see cref="IndexWriteGateTimeoutException"/> rather than returning false: every
    /// caller's answer is the same (do not write), and a boolean would let one forget.</summary>
    public Holding Enter()
    {
        if (!_gate.TryEnter(HoldLimit)) throw new IndexWriteGateTimeoutException(HoldLimit);
        return new Holding(_gate);
    }

    /// <summary>One acquisition of the gate; disposing it releases exactly that one.</summary>
    public readonly struct Holding(Lock gate) : IDisposable
    {
        public void Dispose() => gate.Exit();
    }
}

/// <summary>A caller waited out the gate: busy, not broken.</summary>
internal sealed class IndexWriteGateTimeoutException : TimeoutException
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
    }
}
