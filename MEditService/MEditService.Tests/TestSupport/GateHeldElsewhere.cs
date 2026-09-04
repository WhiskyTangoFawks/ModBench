using MEditService.Core.Records;

namespace MEditService.Tests.TestSupport;

/// <summary>Holds the write gate on a helper thread: <see cref="IndexWriteGate"/> is reentrant, so a
/// test holding it itself would observe nothing. The constructor returns only once the gate is
/// genuinely held.</summary>
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
