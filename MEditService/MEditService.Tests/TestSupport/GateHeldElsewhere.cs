using MEditService.Core.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>
/// #673: holds the process-wide write gate on a helper thread for as long as this handle lives —
/// the one mechanic every gate test shares.
///
/// <para>Deliberately a <i>helper thread</i> rather than the calling one: <see cref="IndexWriteGate"/>
/// is reentrant, so a test that took the gate itself would observe nothing at all — every call under
/// test would sail straight through on the owning thread and the assertion would pass for the wrong
/// reason. The constructor does not return until the gate is genuinely held, so a test never
/// measures a window the holder had not yet entered.</para>
/// </summary>
public sealed class GateHeldElsewhere : IDisposable
{
    private readonly ManualResetEventSlim _release = new();
    private readonly Task _holder;

    public GateHeldElsewhere(IndexWriteGate gate)
    {
        using var held = new ManualResetEventSlim();
        _holder = Task.Run(() =>
        {
            using var _ = gate.Enter();
            held.Set();
            _release.Wait(TimeSpan.FromSeconds(30));
        });
        if (!held.Wait(TimeSpan.FromSeconds(10)))
            throw new InvalidOperationException("The helper thread never took the gate.");
    }

    public void Dispose()
    {
        _release.Set();
        _holder.GetAwaiter().GetResult();
        _release.Dispose();
    }
}
