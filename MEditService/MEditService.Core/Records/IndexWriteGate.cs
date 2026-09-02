namespace MEditService.Core.Records;

/// <summary>
/// #673: the one gate every write to the record index passes through, so two overlapping
/// requests cannot interleave into a corrupt state.
///
/// <para><b>Why a gate at all.</b> The index is one <c>DuckDbRecordIndex</c> holding one
/// <c>DuckDBConnection</c>, reached by singleton services (the edit path, the read-path freshness
/// self-heal, the external-change watcher's timer) that ASP.NET Core runs concurrently.
/// <c>DuckDbConnectionIsolationTests</c> pins what that connection does when two callers reach it at
/// once: a second <c>BeginTransaction()</c> throws <see cref="InvalidOperationException"/>
/// ("Already in a transaction."), and an unwrapped statement silently joins the other caller's
/// transaction and is destroyed by its rollback. Neither is a failure a caller can act on.</para>
///
/// <para><b>Writes only, never reads.</b> Reads are served from the same connection throughout and
/// must not queue behind an in-flight edit — rendering a record listing while an unrelated edit is
/// running is the ordinary case, not contention. So the freshness self-heal takes this around its
/// <i>write</i> and never around its read-and-compare, and no query service takes it at all.</para>
///
/// <para><b>Reentrant, deliberately.</b> Doors nest on the ordinary path — a write endpoint holds
/// the gate and calls into <c>LoadOrderMirror</c>, and <c>ReindexPlugin</c> delegates to
/// <c>ReingestPluginFromSource</c>, which takes it for itself. <see cref="System.Threading.Lock"/>
/// lets the owning thread re-enter, so those chains cost a recursion count rather than a deadlock.
/// This is also why it is a <c>Lock</c> and not a <see cref="SemaphoreSlim"/>, which would
/// self-deadlock on the very first nested call.</para>
///
/// <para><b>Always taken outside <c>LoadOrderMirror._lock</c>, never inside.</b> That lock guards the
/// mirror's own fields and is taken by ordinary read properties; a thread that acquired it first and
/// then waited here would deadlock against a write holding the gate and waiting for it. Every call
/// site in this codebase acquires this gate before any <c>_lock</c> it takes.</para>
/// </summary>
/// <param name="timeout">How long a caller waits before giving up. Defaults to
/// <see cref="DefaultTimeout"/>; the parameter exists so tests need not wait it out.</param>
public sealed class IndexWriteGate(TimeSpan? timeout = null)
{
    /// <summary>
    /// Long enough that no legitimate write can hit it, short enough that a stuck one is reported
    /// rather than hung on forever. The longest thing held under this gate is a whole-plugin
    /// re-derivation — <c>LoadOrderMirror.ReingestPluginFromSource</c>'s tree deserialize or
    /// <c>ReindexOne</c>'s binary deep-parse, both fired from the watcher's timer — which is tens of
    /// seconds on a large plugin, not minutes. Erring long is the safe direction: too long costs a
    /// waiting request a little more patience, too short costs it a spurious 503 on work that was
    /// going to succeed.
    /// </summary>
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromMinutes(2);

    private readonly Lock _gate = new();
    private readonly TimeSpan _timeout = timeout ?? DefaultTimeout;

    /// <summary>How long <see cref="Enter"/> waits before throwing.</summary>
    public TimeSpan Timeout => _timeout;

    /// <summary>
    /// Takes the gate, blocking up to <see cref="Timeout"/>. Dispose the result to release it.
    /// Throws <see cref="IndexWriteGateTimeoutException"/> rather than returning a "did not get it"
    /// value — every caller's answer to that is the same (do not write), and a boolean would let one
    /// of them forget.
    /// </summary>
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

/// <summary>
/// #673: a write waited out <see cref="IndexWriteGate.Timeout"/> for a write already in
/// flight. A <see cref="TimeoutException"/> rather than an <see cref="InvalidOperationException"/>
/// on purpose: the write path already maps that type to "the load order went away", and this is a
/// different answer — the backend is busy, not gone — which the API layer surfaces as its own 503
/// (ADR-0026: a distinguishable shape, never prose a client has to match on).
///
/// <para>Never a write <i>failure</i>: nothing was attempted, so nothing is half-applied.</para>
/// </summary>
public sealed class IndexWriteGateTimeoutException : TimeoutException
{
    private const string DefaultMessage = "Another write to the record index is still in progress.";

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
